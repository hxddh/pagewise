import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";

interface MarkdownProps {
  children: string;
  /** When true, completed paragraphs are parsed once; the tail re-parses on each update. */
  live?: boolean;
}

const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];
const SAFE_IMG_SCHEMES = ["https:", "http:", "asset:", "data:"];

const remarkPlugins = [remarkGfm];
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

function SafeAnchor({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  const target = typeof href === "string" ? href : "";
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

function SafeImg({ src, ...rest }: ImgHTMLAttributes<HTMLImageElement>) {
  const target = typeof src === "string" ? src : "";
  const scheme = schemeOf(target);
  if (!scheme || !SAFE_IMG_SCHEMES.includes(scheme)) return null;
  return <img {...rest} src={target} referrerPolicy="no-referrer" loading="lazy" />;
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

function MarkdownInner({ children, live = false }: MarkdownProps) {
  const { stable, tail } = useMemo(
    () => (live ? splitStreamingMarkdown(children) : { stable: "", tail: children }),
    [children, live],
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
          <span className="message-body-plain">{tail}</span>
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

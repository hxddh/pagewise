import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";

interface MarkdownProps {
  children: string;
  /** When true, completed paragraphs are parsed once; the tail streams as plain text. */
  live?: boolean;
}

const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];
const SAFE_IMG_SCHEMES = ["https:", "asset:", "data:"];

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

/** Split at the last completed paragraph so streaming only re-renders the tail. */
export function splitStreamingMarkdown(text: string): { stable: string; tail: string } {
  const idx = text.lastIndexOf("\n\n");
  if (idx === -1) return { stable: "", tail: text };
  return { stable: text.slice(0, idx), tail: text.slice(idx + 2) };
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
    <div className="markdown">
      {stable ? <ParsedMarkdown text={stable} /> : null}
      {tail ? <div className="message-stream-tail">{tail}</div> : null}
    </div>
  );
}

export const Markdown = memo(MarkdownInner, (prev, next) => {
  if (prev.live !== next.live) return false;
  return prev.children === next.children;
});

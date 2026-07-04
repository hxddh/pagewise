import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";

interface MarkdownProps {
  children: string;
}

const SAFE_LINK_SCHEMES = ["http:", "https:", "mailto:"];
const SAFE_IMG_SCHEMES = ["https:", "asset:", "data:"];

function schemeOf(url: string): string | null {
  try {
    // Resolve relative to a dummy base so bare/relative hrefs don't throw.
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
    // Render as plain, non-navigating text for disallowed/unknown schemes.
    return <span {...rest}>{children}</span>;
  }

  return (
    <a
      {...rest}
      href={target}
      onClick={(e) => {
        // Never let the privileged webview navigate itself — hand off to the OS.
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
  // Block remote http/tracking-pixel images; only allow safe local/https sources.
  if (!scheme || !SAFE_IMG_SCHEMES.includes(scheme)) return null;
  return <img {...rest} src={target} referrerPolicy="no-referrer" loading="lazy" />;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: SafeAnchor, img: SafeImg }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

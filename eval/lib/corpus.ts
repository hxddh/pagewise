/**
 * The corpus as the app sees it: every document run through the extractor
 * the app ships (`eval/extract`, which includes `src-tauri/src/inspect.rs` by
 * path), cached under `eval/out/`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { TextItemRect } from "../../src/lib/types";

export const ROOT = resolve(__dirname, "../..");
export const CORPUS = join(ROOT, "eval/corpus");
export const OUT = join(ROOT, "eval/out");
const BIN = join(ROOT, "eval/extract/target/release/pagewise-eval-extract");

export interface DumpPage {
  page: number;
  /** The page text the assistant is given (Markdown). */
  text: string;
  needs_vision: boolean;
  /** The runs a citation is located against. */
  items: TextItemRect[];
  items_error: string | null;
}

export interface DumpDoc {
  id: string;
  file: string;
  page_count: number;
  pages: DumpPage[];
}

function ensureBinary(): void {
  if (existsSync(BIN)) return;
  execFileSync("cargo", ["build", "--release", "--manifest-path", join(ROOT, "eval/extract/Cargo.toml")], {
    stdio: "inherit",
  });
}

/** Every PDF in the corpus, plus fetched third-party documents when present. */
export function corpusFiles(): string[] {
  const list = (dir: string) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".pdf"))
          .sort()
          .map((f) => join(dir, f))
      : [];
  return [...list(CORPUS), ...list(join(CORPUS, "fetched"))];
}

export function loadDoc(file: string): DumpDoc {
  mkdirSync(OUT, { recursive: true });
  const id = basename(file, ".pdf");
  const cache = join(OUT, `${id}.dump.json`);
  if (!existsSync(cache) || statSync(cache).mtimeMs < statSync(file).mtimeMs) {
    ensureBinary();
    const json = execFileSync(BIN, [file], { maxBuffer: 1 << 30 }).toString("utf8");
    writeFileSync(cache, json);
  }
  const raw = JSON.parse(readFileSync(cache, "utf8")) as Omit<DumpDoc, "id">;
  return { id, ...raw };
}

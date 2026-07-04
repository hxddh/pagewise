#!/usr/bin/env node
/**
 * Pre-release secret scan. Fails if likely API keys or credentials are tracked in source.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "target",
  ".git",
  "src-tauri/target",
]);

const SKIP_FILES = new Set(["package-lock.json", "scripts/check-secrets.mjs"]);

const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".md", ".rs", ".toml", ".yaml", ".yml",
  ".env", ".env.example",
]);

const PATTERNS = [
  {
    name: "OpenAI-style key",
    re: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    allow: (line) => line.includes("sk-…") || line.includes("sk-...") || line.includes('"sk-test"'),
  },
  {
    name: "Bearer token",
    re: /\bBearer\s+[a-zA-Z0-9._-]{20,}\b/g,
    allow: () => false,
  },
  {
    name: "Generic API key assignment",
    re: /(?:api[_-]?key|apikey|secret|password)\s*[:=]\s*['"][^'"\s]{12,}['"]/gi,
    allow: (line) =>
      line.includes("apiKey:") && line.includes('""') ||
      line.includes("apiKey: ''") ||
      line.includes('apiKey: ""') ||
      line.includes("placeholder") ||
      line.includes("NotRequired") ||
      line.includes("sk-…") ||
      line.includes("sk-test") ||
      line.includes("type=") ||
      line.includes("password") && line.includes("showKey"),
  },
  {
    name: "AWS key",
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    allow: () => false,
  },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (SKIP_DIRS.has(name) || rel.startsWith("src-tauri/target")) continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

const findings = [];

for (const file of walk(root)) {
  const rel = relative(root, file);
  if (SKIP_FILES.has(rel)) continue;
  const ext = rel.slice(rel.lastIndexOf("."));
  if (!TEXT_EXT.has(ext) && !rel.startsWith(".env")) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  const lines = text.split("\n");
  for (const { name, re, allow } of PATTERNS) {
    re.lastIndex = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (allow(line)) continue;
      const matches = line.match(re);
      if (matches) {
        for (const m of matches) {
          findings.push({ file: rel, line: i + 1, kind: name, sample: m.slice(0, 12) + "…" });
        }
      }
    }
  }
}

if (findings.length) {
  console.error("Secret scan FAILED — possible credentials in repository:\n");
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line} [${f.kind}] ${f.sample}`);
  }
  process.exit(1);
}

console.log("Secret scan passed — no hardcoded credentials detected.");

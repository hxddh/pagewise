#!/usr/bin/env node
/**
 * Pre-release secret scan.
 *
 * Fails if likely API keys or credentials are found in git-tracked source.
 *
 * Design notes:
 *  - Scans the git-tracked file list (`git ls-files`) rather than an extension
 *    allowlist, so index.html, shell scripts, .plist, Dockerfile, etc. are all
 *    covered. Only obvious binary / lock files are skipped.
 *  - The secret pattern is matched FIRST, then the allowlist is applied to the
 *    matched TOKEN — never the whole line. This means a trailing comment such
 *    as `// type=` can no longer whitelist a real key on the same line.
 *  - Dependency-free (Node built-ins only).
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const selfRel = relative(root, fileURLToPath(import.meta.url)).replace(/\\/g, "/");

// Files that legitimately contain hash-like or long random strings, plus this
// scanner itself (its regexes would otherwise self-match).
const SKIP_FILES = new Set([
  "package-lock.json",
  "src-tauri/Cargo.lock",
  selfRel,
]);

// Obvious binary / non-source extensions we never scan.
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".icns",
  ".svg", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tgz", ".dmg", ".lock",
]);

// Markers that indicate a matched token is a placeholder / documentation
// example rather than a real credential.
function isPlaceholderToken(token) {
  const t = token.toLowerCase();
  if (
    t.includes("example") ||
    t.includes("placeholder") ||
    t.includes("redacted") ||
    t.includes("changeme") ||
    t.includes("your-") ||
    t.includes("yourkey") ||
    t.includes("dummy") ||
    t.includes("test") ||
    t.includes("xxxx") ||
    t.includes("…") ||
    t.includes("...")
  ) {
    return true;
  }
  // A run of a single repeated character (e.g. sk-aaaaaaaa..., 000000...).
  const body = token.replace(/^(sk-[a-z0-9]+-|sk-|ghp_|AIza|AKIA|xox[baprs]-|Bearer\s+)/i, "");
  if (/^(.)\1{7,}$/.test(body)) return true;
  return false;
}

const PATTERNS = [
  {
    // OpenRouter (sk-or-v1-…), OpenAI (sk-proj-…, sk-…), Anthropic (sk-ant-…).
    name: "OpenAI/Anthropic/OpenRouter-style key",
    re: /sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "GitHub personal access token",
    re: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    name: "Google API key",
    re: /AIza[A-Za-z0-9_-]{35}/g,
  },
  {
    name: "Slack token",
    re: /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    name: "AWS access key id",
    re: /AKIA[0-9A-Z]{16}/g,
  },
  {
    name: "Bearer token",
    re: /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  },
  {
    // Generic `apiKey: "…"` / `secret = '…'` assignments. The token allowlist
    // (value between the quotes) is what gets placeholder-checked.
    name: "Generic credential assignment",
    re: /(?:api[_-]?key|apikey|secret|password|token)\s*[:=]\s*['"]([^'"\s]{12,})['"]/gi,
    tokenGroup: 1,
  },
];

function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

const findings = [];

for (const rel of trackedFiles()) {
  if (SKIP_FILES.has(rel)) continue;
  const dot = rel.lastIndexOf(".");
  const ext = dot >= 0 ? rel.slice(dot).toLowerCase() : "";
  if (SKIP_EXT.has(ext)) continue;

  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch {
    continue;
  }
  // Heuristic binary guard: skip files with NUL bytes.
  if (text.includes("\0")) continue;

  const lines = text.split("\n");
  for (const { name, re, tokenGroup } of PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const token = tokenGroup != null ? m[tokenGroup] : m[0];
        if (!token) continue;
        if (isPlaceholderToken(token)) continue;
        findings.push({
          file: rel,
          line: i + 1,
          kind: name,
          sample: token.slice(0, 12) + "…",
        });
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

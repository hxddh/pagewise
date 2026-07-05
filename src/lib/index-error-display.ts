/** User-safe index failure detail (no raw API payloads). */
export function sanitizeIndexErrorDetail(error: string | undefined): string | undefined {
  if (!error?.trim()) return undefined;
  const msg = error.trim();
  if (/\b429\b|rate.?limit|too many requests/i.test(msg)) {
    return "rate_limited";
  }
  if (/api[_\s-]?key|unauthorized|401|403|authentication/i.test(msg)) {
    return "auth";
  }
  if (/timeout|timed out/i.test(msg)) {
    return "timeout";
  }
  if (/too little text/i.test(msg)) {
    return "sparse";
  }
  return undefined;
}

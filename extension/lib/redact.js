/**
 * Redaction for Advanced-mode capture buffers.
 *
 * Console text and request URLs routinely carry bearer tokens and one-time
 * codes. The tool contract advertises these buffers as redacted, so stripping
 * happens at append time, a buffer must never hold a secret it could later
 * hand to an agent.
 */

const MAX_TEXT_LENGTH = 2000;

const PATTERNS = [
  // Authorization schemes, not just Bearer: Basic carries base64 credentials.
  [/\b(bearer|basic|token|digest)(\s+)[a-z0-9._~+\-/]+=*/gi, "$1$2[redacted]"],
  // Credential-shaped assignments wherever they appear, a query string, a log
  // line, a JSON fragment, with `=` or `:` and optional quoting.
  [
    /\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|client[_-]?secret|secret|password|passwd|pwd|token|signature|sig|auth|session[_-]?id|code)["']?\s*[=:]\s*["']?)[^\s"'&#,;)}\]]+/gi,
    "$1[redacted]",
  ],
  // Userinfo in a URL: https://user:password@host/...
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1[redacted]@"],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)\b/g, "[redacted-jwt]"],
];

/** Strip credential-shaped substrings from free text and cap its length. */
export function redactText(value, max = MAX_TEXT_LENGTH) {
  let out = String(value ?? "");
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out.slice(0, max);
}

/**
 * Reduce a URL to origin + path. Query strings and fragments are dropped
 * wholesale rather than filtered, because credential parameter names vary by
 * service and an allowlist would leak the ones we failed to predict.
 */
export function redactUrl(value) {
  const raw = String(value ?? "");
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    // Credentials also ride in userinfo and, for some signed URLs, in the path.
    url.username = "";
    url.password = "";
    return redactText(url.toString(), MAX_TEXT_LENGTH);
  } catch {
    return redactText(raw.split(/[?#]/, 1)[0] || raw, MAX_TEXT_LENGTH);
  }
}

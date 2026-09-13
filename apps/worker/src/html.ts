/**
 * The only HTML this Worker renders itself: a terminal error page.
 *
 * There is deliberately no consent or approval page -- Yoto's own login and
 * consent screen is the consent. If a parent ever sees a page served by us, it
 * is because something went wrong.
 */

/**
 * Applied to every HTML response. `script-src` is absent from the allowlist
 * because `default-src 'none'` already forbids it: these pages ship zero
 * JavaScript, which is what lets the policy stay this tight.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
};

export function withSecurityHeaders(
  response: Response,
  cacheControl = "no-store",
  options: { scriptHash?: string } = {},
): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(name, value);
  }
  if (options.scriptHash) {
    // `default-src 'none'` still forbids every OTHER script; this allows
    // exactly the one inline <script> block whose exact bytes hash to this
    // value (the landing page's copy-to-clipboard button) -- see
    // `scriptContentHash` below, which derives the hash from the page's own
    // served bytes so the two can never drift out of sync.
    out.headers.set(
      "content-security-policy",
      `${SECURITY_HEADERS["content-security-policy"]}; script-src 'sha256-${options.scriptHash}'`,
    );
  }
  out.headers.set("cache-control", cacheControl);
  return out;
}

const INLINE_SCRIPT_PATTERN = /<script>([\s\S]*?)<\/script>/;

/**
 * SHA-256 (base64) of the first bare `<script>...</script>` block's exact
 * text content, for a CSP `script-src 'sha256-...'` allowlist entry. Computed
 * from the page's own served HTML rather than a hand-maintained constant, so
 * editing the script can never silently drift out of sync with the header
 * that allows it. Returns `undefined` when the page has no such block.
 */
export async function scriptContentHash(html: string): Promise<string | undefined> {
  const match = INLINE_SCRIPT_PATTERN.exec(html);
  if (!match?.[1]) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(match[1]));
  return base64(new Uint8Array(digest));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PAGE_STYLE = [
  "color-scheme: light dark",
  "font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif",
  "margin: 0 auto",
  "max-width: 34rem",
  "padding: 4rem 1.5rem",
].join(";");

/**
 * A self-contained error page. `message` must already be safe to show a
 * stranger: no client ids, no upstream response bodies, no identifiers.
 */
export function errorPage(status: number, title: string, message: string): Response {
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} &middot; mcp-yoto</title>
</head>
<body style="${PAGE_STYLE}">
<h1 style="font-size:1.3rem">${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p>Close this tab and start the connection again from your AI app. If it keeps
happening, the project page has troubleshooting notes.</p>
<p><a href="https://github.com/danpillay87/mcp-yoto">github.com/danpillay87/mcp-yoto</a></p>
</body>
</html>
`;
  return withSecurityHeaders(
    new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } }),
  );
}

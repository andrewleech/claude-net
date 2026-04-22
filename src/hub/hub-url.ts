/**
 * Resolve the hub's "canonical" public base URL — the single URL every
 * client (binary downloads, MCP plugin WebSocket, mirror-agent WebSocket,
 * mirror URLs) must be able to reach.
 *
 * Priority:
 *   1. CLAUDE_NET_HOST starts with http:// or https:// → use verbatim.
 *      This is the recommended setting for any deployment behind a
 *      reverse proxy or with a public domain.
 *   2. CLAUDE_NET_HOST is a plain hostname (optionally with :port) →
 *      assume http://, append internal port if missing. Back-compat
 *      path for existing local installs.
 *   3. No CLAUDE_NET_HOST → fall back to the request's own Host header
 *      + X-Forwarded-Proto (or http). Works for bare local hubs with
 *      no env config.
 *
 * We deliberately DO NOT consult X-Forwarded-Host here: the whole point
 * of the canonical model is that every client sees the same URL
 * regardless of which entry point (public vs LAN) they arrived through.
 * If an operator wants request-host-following behaviour, they simply
 * leave CLAUDE_NET_HOST unset and rely on step 3.
 */
export function resolveCanonicalHubUrl(
  request: Request,
  externalHost: string | undefined,
  port: number | undefined,
): string {
  if (externalHost) {
    if (/^https?:\/\//i.test(externalHost)) {
      // Strip trailing slash for consistent concatenation downstream.
      return externalHost.replace(/\/+$/, "");
    }
    const withPort =
      externalHost.includes(":") || !port
        ? externalHost
        : `${externalHost}:${port}`;
    return `http://${withPort}`;
  }
  const host = request.headers.get("host") ?? `localhost:${port ?? 4815}`;
  const scheme =
    request.headers.get("x-forwarded-proto") ??
    (request.url.startsWith("https:") ? "https" : "http");
  return `${scheme === "https" ? "https" : "http"}://${host}`;
}

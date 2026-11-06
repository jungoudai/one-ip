// Lightweight connectivity probes served outside /api: no Origin check, no
// rate limit, no body. They mirror the common captive-portal endpoints
// (e.g. connectivitycheck.gstatic.com/generate_204) so proxy clients and
// network tests can point at this deployment directly.

export const FIN_PATH = "/fin";
const STATUS = { "/generate_204": 204, "/generate_200": 200 };
const FIN_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Hello World</title></head><body><h1>Hello World</h1></body></html>\n';
export const PROBE_PATHS = [...Object.keys(STATUS), FIN_PATH];

const headers = (extra = {}) => ({
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Access-Control-Allow-Origin": "*",
  ...extra,
});

/** Returns a Response for a probe path, or undefined for any other path. */
export function connectivityProbe(request, pathname) {
  const status = STATUS[pathname];
  if (status === undefined && pathname !== FIN_PATH) return undefined;
  if (!["GET", "HEAD"].includes(request.method))
    return new Response(null, {
      status: 405,
      headers: headers({ Allow: "GET, HEAD" }),
    });
  if (pathname === FIN_PATH)
    // Reply with a tiny page and ask for the connection to be closed. The
    // Node server ends the socket (FIN) once this is written; on Cloudflare
    // the edge owns the client TCP connection and decides when to close it.
    return new Response(request.method === "HEAD" ? null : FIN_HTML, {
      headers: headers({
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
      }),
    });
  return new Response(null, {
    status,
    headers: headers(status === 200 ? { "Content-Length": "0" } : {}),
  });
}

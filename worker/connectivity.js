// Lightweight connectivity probes served outside /api: no Origin check, no
// rate limit, no body. They mirror the common captive-portal endpoints
// (e.g. connectivitycheck.gstatic.com/generate_204) so proxy clients and
// network tests can point at this deployment directly.

export const FIN_PATH = "/fin";
const STATUS = { "/generate_204": 204, "/generate_200": 200 };
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
    // Cloudflare's edge owns the client TCP connection, so a Worker cannot
    // send FIN itself. This asks for the connection to be closed after the
    // reply; the Node server closes the socket without replying instead.
    return new Response(null, {
      status: 204,
      headers: headers({ Connection: "close" }),
    });
  return new Response(null, {
    status,
    headers: headers(status === 200 ? { "Content-Length": "0" } : {}),
  });
}

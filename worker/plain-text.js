// Plain-text answers for command-line clients (`curl ip.example.com`).
// Browsers keep getting the SPA; only these paths are routed to the Worker
// first, and only CLI user agents get text instead of the page.
import { cfGeo, geoIp } from "./geo.js";
import { clientIp, publicIp } from "./http.js";
import { rateLimit } from "./rate-limit.js";

export const PLAIN_PATHS = ["/", "/ip"];
const CLI_AGENT = /^(?:curl|wget|httpie|xh|fetch|aria2|lwp-request)\b/i;

export function isCliClient(request) {
  return CLI_AGENT.test(request.headers.get("User-Agent") ?? "");
}

const headers = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  Vary: "User-Agent",
};
const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { ...headers, ...extra } });

function visitorIp(request, env) {
  if (env.LOCAL_DEV === "true") return undefined;
  try {
    return publicIp(clientIp(request) ?? "");
  } catch {
    return undefined;
  }
}

function lines(info) {
  const place = [info.city, info.region].filter(Boolean);
  if (place[0] && place[0] === place[1]) place.pop();
  const country =
    info.country && info.country_code && info.country !== info.country_code
      ? `${info.country} (${info.country_code})`
      : (info.country ?? info.country_code);
  if (country) place.push(country);
  const asn = info.asn ? `AS${String(info.asn).replace(/^AS/i, "")}` : "";
  const rows = [
    ["IP", info.ip],
    ["Location", place.join(", ")],
    ["ISP", info.isp],
    ["ASN", asn],
    ["Timezone", info.timezone],
    [
      "Coords",
      Number.isFinite(info.latitude) && Number.isFinite(info.longitude)
        ? `${info.latitude}, ${info.longitude}`
        : "",
    ],
  ].filter(([, value]) => value);
  return (
    rows.map(([key, value]) => `${`${key}:`.padEnd(10)}${value}`).join("\n") +
    "\n"
  );
}

/**
 * Returns a text/plain Response for CLI clients on PLAIN_PATHS, or undefined
 * so the caller serves the normal page.
 *   /    full summary: IP, location, ISP, ASN, timezone
 *   /ip  just the IP, for scripts: `IP=$(curl -s host/ip)`
 */
export async function plainText(request, pathname, env) {
  if (!PLAIN_PATHS.includes(pathname) || !isCliClient(request)) return;
  const response = await answer(request, pathname, env);
  return request.method === "HEAD" ? new Response(null, response) : response;
}

async function answer(request, pathname, env) {
  if (!["GET", "HEAD"].includes(request.method))
    return text("Method not allowed\n", 405, { Allow: "GET, HEAD" });
  const ip = visitorIp(request, env);
  if (!ip) return text("Unable to determine your public IP\n", 503);
  if (pathname === "/ip") return text(`${ip}\n`);
  if (!(await rateLimit(env.API_LIMITER, ip, "api", 180)))
    return text("Too many requests, retry in a minute\n", 429);
  let info = { ...cfGeo(request), ip };
  // Cloudflare fills request.cf at the edge; the Node server has no such
  // metadata, so look the address up the same way /api/me does.
  if (!info.country && !info.asn) info = await geoIp(ip).catch(() => ({ ip }));
  return text(lines(info));
}

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import worker from "../worker/index.js";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export const normalizeIp = (ip) => ip?.replace(/^::ffff:/i, "") ?? "";

export function trustedProxyList(value = "") {
  const list = new BlockList();
  for (const entry of value.split(",").filter((item) => item.trim())) {
    const [ip, prefix] = entry.trim().split("/");
    const version = isIP(ip);
    const bits = Number(prefix);
    if (
      !version ||
      (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || bits > (version === 6 ? 128 : 32)))
    )
      throw new Error("TRUSTED_PROXIES must contain IP addresses or CIDRs");
    const family = version === 6 ? "ipv6" : "ipv4";
    if (prefix === undefined) list.addAddress(ip, family);
    else list.addSubnet(ip, bits, family);
  }
  return list;
}

export function publicOrigin(value = "") {
  if (!value.trim()) return undefined;
  const url = new URL(value.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "PUBLIC_ORIGIN must be an origin such as https://ip.example.com",
    );
  return url.origin;
}

/** Read only the global `/*` block; path-scoped rules are not emulated. */
export function globalHeaders(text) {
  const headers = {};
  let global = false;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      global = line.trim() === "/*";
      continue;
    }
    const index = line.indexOf(":");
    if (global && index > 0)
      headers[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return headers;
}

function staticAssets(root) {
  return async (request) => {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (
      pathname.split("/").some((part) => part.startsWith(".")) ||
      /^\/(?:worker|_worker\.js|_headers|_redirects|_routes\.json|\.assetsignore)(?:\/|$)/.test(
        pathname,
      )
    )
      return new Response("Not found", { status: 404 });
    let file = resolve(root, `.${pathname}`);
    if (!file.startsWith(`${root}${sep}`) && file !== root)
      return new Response("Not found", { status: 404 });
    let info = await stat(file).catch(() => undefined);
    let fallback = false;
    if (!info?.isFile()) {
      if (
        pathname.startsWith("/assets/") ||
        (extname(pathname) &&
          !request.headers.get("Accept")?.includes("text/html"))
      )
        return new Response("Not found", { status: 404 });
      file = resolve(root, "index.html");
      info = await stat(file);
      fallback = true;
    }
    return new Response(
      request.method === "HEAD" ? null : Readable.toWeb(createReadStream(file)),
      {
        headers: {
          "Content-Type": mime[extname(file)] ?? "application/octet-stream",
          "Content-Length": String(info.size),
          "Cache-Control":
            !fallback && pathname.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "no-cache",
        },
      },
    );
  };
}

/**
 * Build the standalone request handler. It receives transport facts from the
 * Node adapter and returns a Web Response, so it can be tested without ports.
 */
export async function createApp({
  assets,
  config = process.env,
  log = console,
}) {
  const root = resolve(assets);
  const proxies = trustedProxyList(config.TRUSTED_PROXIES);
  const origin = publicOrigin(config.PUBLIC_ORIGIN);
  const trustCf = config.TRUST_CF_CONNECTING_IP === "true";
  const securityHeaders = globalHeaders(
    await readFile(resolve(root, "_headers"), "utf8"),
  );
  const env = {
    ...config,
    LOCAL_DEV: "false",
    // Only this Node server owns the TCP socket, so only it can serve /fin.
    FIN_ENABLED: "true",
    ASSETS: { fetch: staticAssets(root) },
  };
  let warnedMissingForward = false;

  async function handle({ method, target, headers, body, peer }) {
    peer = normalizeIp(peer);
    const trusted =
      isIP(peer) > 0 && proxies.check(peer, isIP(peer) === 6 ? "ipv6" : "ipv4");
    // Never accept a client-supplied Cloudflare identity unless a trusted
    // proxy is explicitly configured to relay it.
    const cfIp = normalizeIp(headers.get("CF-Connecting-IP")?.trim());
    headers.delete("CF-Connecting-IP");
    const forwardedIp = normalizeIp(
      headers.get("X-Forwarded-For")?.split(",").at(-1)?.trim(),
    );
    let clientIp = peer;
    let source = "socket";
    if (trusted) {
      if (trustCf && isIP(cfIp))
        [clientIp, source] = [cfIp, "cloudflare-proxy"];
      else if (isIP(forwardedIp))
        [clientIp, source] = [forwardedIp, "reverse-proxy"];
      else {
        clientIp = undefined;
        source = "reverse-proxy";
        if (!warnedMissingForward) {
          warnedMissingForward = true;
          log.warn(
            JSON.stringify({
              event: "proxy_missing_client_ip",
              hint: "set X-Forwarded-For",
            }),
          );
        }
      }
    }
    if (!target?.startsWith("/")) throw new URIError("Invalid request target");
    const protocol =
      trusted &&
      headers.get("X-Forwarded-Proto")?.split(",").at(-1)?.trim() === "https"
        ? "https"
        : "http";
    const base =
      origin ??
      new URL(`${protocol}://${headers.get("Host") ?? "localhost"}`).origin;
    const request = new Request(`${base}${target}`, {
      method,
      headers,
      ...(body && !["GET", "HEAD"].includes(method)
        ? { body, duplex: "half" }
        : {}),
    });
    request.clientIp = clientIp;
    request.clientIpSource = source;
    const response =
      new URL(request.url).pathname === "/healthz"
        ? new Response("ok\n", { headers: { "Cache-Control": "no-store" } })
        : await worker.fetch(request, env);
    if (method === "HEAD") await response.body?.cancel();
    const merged = new Headers(securityHeaders);
    for (const [name, value] of response.headers) merged.set(name, value);
    return new Response(method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: merged,
    });
  }

  return { handle, securityHeaders };
}

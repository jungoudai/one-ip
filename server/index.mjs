import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.mjs";
import { installMemoryCache } from "./memory-cache.mjs";
import { FIN_PATH } from "../worker/connectivity.js";

// Node has no Cloudflare edge cache; keep upstream lookups bounded per process.
installMemoryCache();
const { handle, securityHeaders } = await createApp({
  assets: fileURLToPath(new URL("../dist/", import.meta.url)),
});

const server = createServer(
  { maxHeaderSize: 16_384, requestTimeout: 30_000 },
  async (incoming, outgoing) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const response = await handle({
        method: incoming.method,
        target: incoming.url,
        headers,
        body: Readable.toWeb(incoming),
        peer: incoming.socket.remoteAddress,
      });
      const outHeaders = {};
      for (const [name, value] of response.headers)
        if (name !== "set-cookie") outHeaders[name] = value;
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outHeaders["set-cookie"] = cookies;
      outgoing.writeHead(response.status, outHeaders);
      if (!response.body) outgoing.end();
      else await pipeline(Readable.fromWeb(response.body), outgoing);
      // Send FIN as soon as the reply is written: end() half-closes the
      // socket (not RST), so the client gets the full page, then the close.
      if (incoming.url?.split("?")[0] === FIN_PATH) incoming.socket.end();
    } catch (error) {
      console.error(
        JSON.stringify({ event: "server_error", type: error?.name ?? "Error" }),
      );
      if (!outgoing.headersSent) {
        outgoing.writeHead(
          error instanceof URIError || error instanceof TypeError ? 400 : 500,
          {
            ...securityHeaders,
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-store",
          },
        );
        outgoing.end("Request failed");
      } else outgoing.destroy();
    }
  },
);
// Outlive common reverse-proxy upstream keep-alive timeouts (nginx: 60s).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => {
  console.log("One IP server ready");
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });

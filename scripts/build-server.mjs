import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PROBE_PATHS } from "../worker/connectivity.js";
import { PLAIN_PATHS } from "../worker/plain-text.js";

const root = new URL("../", import.meta.url);
const target = process.argv[2];
if (!["pages", "docker"].includes(target))
  throw new Error("Expected deployment target: pages or docker");

const output = new URL(target === "pages" ? "dist-pages/" : ".output/", root);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
if (target === "pages")
  await cp(new URL("dist/", root), output, { recursive: true });

await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: [target === "pages" ? "worker/index.js" : "server/index.mjs"],
  outfile: fileURLToPath(
    new URL(target === "pages" ? "_worker.js" : "server.mjs", output),
  ),
  bundle: true,
  format: "esm",
  platform: target === "pages" ? "browser" : "node",
  target: "es2023",
  external: ["node:*"],
});

if (target === "pages") {
  await writeFile(
    new URL("_routes.json", output),
    JSON.stringify(
      {
        version: 1,
        include: [
          "/api",
          "/api/*",
          "/worker",
          "/worker/*",
          ...PROBE_PATHS,
          ...PLAIN_PATHS,
        ],
        exclude: [],
      },
      null,
      2,
    ) + "\n",
  );
}

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".ogg": "audio/ogg",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".track": "text/plain; charset=utf-8",
};

export interface StaticServer {
  readonly origin: string;
  close(): Promise<void>;
}

/** Minimal read-only static file server bound to 127.0.0.1 on a random port. */
export async function serveDirectory(root: string): Promise<StaticServer> {
  const base = normalize(root + sep);
  const server: Server = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const file = normalize(join(base, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath));
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

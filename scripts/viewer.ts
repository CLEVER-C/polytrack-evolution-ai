/**
 * Starts the local replay viewer. Training does not need it; it only reads data/runs/.
 *
 *   npm run viewer -- [--port 8737] [--run <run>] [--open]
 *   npm run watch:evolution -- [--run <run>] [--pause 1.5]     (opens in Watch Evolution mode)
 *
 * Then open the printed URL in a browser.
 */
import { spawn } from "node:child_process";
import { DEFAULT_VIEWER_PORT, ViewerServer } from "../src/viewer/ViewerServer.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const server = await ViewerServer.start({ port: Number(arg("port") ?? DEFAULT_VIEWER_PORT) });
  const params = new URLSearchParams();
  const run = arg("run");
  if (run !== undefined) params.set("run", run);
  if (flag("watch")) params.set("watch", "1");
  const pause = arg("pause");
  if (pause !== undefined) params.set("pause", pause);
  const url = `${server.origin}/${params.size > 0 ? `?${params}` : ""}`;
  console.log(`PolyTrack Evolution AI viewer: ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (flag("open")) {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  }
  const stop = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

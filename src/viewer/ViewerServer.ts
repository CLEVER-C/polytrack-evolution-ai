/**
 * Local web server for the replay viewer (npm run viewer). Nothing here is
 * involved in training; it only reads what training saved.
 *
 *   /                      the viewer UI (viewer/ in the project)
 *   /game/...              the UNMODIFIED PolyTrack 0.6.3 files (vendor/), used by the
 *                          browser to render with the game's own renderer, car and track code
 *   /api/runs              saved runs
 *   /api/generations?run=  per-generation summaries (best/avg fitness, time, checkpoints)
 *   /api/status?run=       live training status (status.json)
 *   /api/player/...        the ReplayPlayer: load / play / pause / resume / restart / step / speed
 *   /api/player/stream     Server-Sent Events: one ReplayFrame (real physics state) per tick of the viewer clock
 *
 * Every response carries a Content-Security-Policy that only allows this
 * origin, so the game code running in the viewer cannot contact Kodub's
 * servers (leaderboards, profiles) or anything else.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, sep } from "node:path";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../polytrack/local/capture.js";
import { GAME_DIR, PROJECT_ROOT } from "../polytrack/local/paths.js";
import { MIME } from "../polytrack/local/staticServer.js";
import type { Replay } from "../evolution/Replay.js";
import { RunCatalog, type GenerationSummary } from "./RunCatalog.js";
import { ReplayPlayer, type ReplayFrame, type ReplayPlayerDependencies } from "./ReplayPlayer.js";

export const VIEWER_WEB_DIR = join(PROJECT_ROOT, "viewer");
export const DEFAULT_VIEWER_PORT = 8737;

const CSP = [
  "default-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
  "connect-src 'self' data: blob:",
  "frame-ancestors 'self'",
].join("; ");

export interface ViewerServerOptions {
  /** 0 = any free port. */
  readonly port?: number;
  readonly host?: string;
  readonly catalog?: RunCatalog;
  readonly playerDeps?: ReplayPlayerDependencies;
  /** Viewer clock period: how often the player advances and a frame is streamed. */
  readonly frameIntervalMs?: number;
}

/** What is loaded in the player, as sent to the browser. */
export interface LoadedReplayInfo {
  readonly run: string;
  readonly generation: number;
  readonly summary: GenerationSummary;
  readonly individualId: string;
  readonly fitness: number;
  readonly totalTicks: number;
  readonly ticksPerStep: number;
  readonly stats: Replay["stats"];
  readonly track: { readonly id: string; readonly name: string; readonly sha256: string; readonly url: string };
}

export async function defaultPlayerDependencies(): Promise<ReplayPlayerDependencies> {
  const [init, gameData] = await Promise.all([loadCapturedInit(), loadCapturedGameData()]);
  return { init, gameData, loadTrack: loadCapturedTrack };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class ViewerServer {
  private loaded: LoadedReplayInfo | null = null;
  private readonly clients = new Set<ServerResponse>();
  /** Player commands and clock ticks run one at a time, in order. */
  private queue: Promise<unknown> = Promise.resolve();
  private clock: NodeJS.Timeout | null = null;
  private lastClock = performance.now();
  /** Incremented when the car jumps (load/restart) so the renderer resets cameras and effects. */
  private resetSeq = 0;
  private lastSent = "";

  private constructor(
    private readonly server: Server,
    readonly origin: string,
    readonly player: ReplayPlayer,
    readonly catalog: RunCatalog,
    private readonly frameIntervalMs: number,
  ) {}

  static async start(options: ViewerServerOptions = {}): Promise<ViewerServer> {
    const player = new ReplayPlayer(options.playerDeps ?? (await defaultPlayerDependencies()));
    const catalog = options.catalog ?? new RunCatalog();
    const server = createServer();
    const host = options.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? DEFAULT_VIEWER_PORT, host, resolve);
    });
    const { port } = server.address() as AddressInfo;
    const viewer = new ViewerServer(server, `http://${host}:${port}`, player, catalog, options.frameIntervalMs ?? 1000 / 60);
    server.on("request", (req, res) => void viewer.handle(req, res));
    viewer.clock = setInterval(() => viewer.onClock(), viewer.frameIntervalMs);
    return viewer;
  }

  get loadedReplay(): LoadedReplayInfo | null {
    return this.loaded;
  }

  async close(): Promise<void> {
    if (this.clock !== null) clearInterval(this.clock);
    for (const res of this.clients) res.end();
    this.clients.clear();
    await this.queue.catch(() => undefined);
    await this.player.dispose();
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  /** Loads one generation's best replay into the player (paused at tick 0). */
  async loadGeneration(run: string, generation: number): Promise<LoadedReplayInfo> {
    return this.enqueue(async () => {
      const { replay, summary } = await this.catalog.loadGenerationReplay(run, generation);
      await this.player.loadReplay(replay);
      const track = this.player.getTrack()!;
      this.loaded = {
        run,
        generation,
        summary,
        individualId: replay.individualId,
        fitness: replay.fitness,
        totalTicks: replay.stats.ticks,
        ticksPerStep: replay.episode.ticksPerStep,
        stats: replay.stats,
        track: { id: replay.trackId, name: replay.trackName, sha256: replay.trackSha256, url: `/game/${track.file}` },
      };
      this.resetSeq++;
      this.broadcast(true);
      return this.loaded;
    });
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onClock(): void {
    const now = performance.now();
    const elapsed = now - this.lastClock;
    this.lastClock = now;
    if (this.loaded === null || !this.player.isPlaying()) return;
    void this.enqueue(async () => {
      await this.player.advance(elapsed);
      this.broadcast(false);
    });
  }

  private frameMessage(): string {
    const frame: (ReplayFrame & { resetSeq: number; run: string; generation: number }) | null =
      this.loaded === null ? null : { ...this.player.getFrame(), resetSeq: this.resetSeq, run: this.loaded.run, generation: this.loaded.generation };
    return JSON.stringify(frame);
  }

  /** Sends the current frame to every stream client (unless nothing changed). */
  private broadcast(force: boolean): void {
    const message = this.frameMessage();
    if (!force && message === this.lastSent) return;
    this.lastSent = message;
    for (const res of this.clients) res.write(`data: ${message}\n\n`);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("content-security-policy", CSP);
    res.setHeader("x-content-type-options", "nosniff");
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await this.handleApi(req, res, url);
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      if (url.pathname === "/" || url.pathname === "/index.html") return this.sendFile(res, VIEWER_WEB_DIR, "/index.html");
      if (url.pathname.startsWith("/viewer/")) return this.sendFile(res, VIEWER_WEB_DIR, url.pathname.slice("/viewer".length));
      if (url.pathname.startsWith("/game/")) return this.sendFile(res, GAME_DIR, url.pathname.slice("/game".length));
      throw new HttpError(404, "Not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    const run = (): string => {
      const r = url.searchParams.get("run");
      if (r === null || r === "") throw new HttpError(400, "Missing ?run=");
      return r;
    };
    switch (route) {
      case "GET /api/runs":
        return sendJson(res, 200, { runs: await this.catalog.listRuns() });
      case "GET /api/generations":
        return sendJson(res, 200, { run: run(), generations: await this.catalog.getGenerations(run()) });
      case "GET /api/status":
        return sendJson(res, 200, { run: run(), status: await this.catalog.getStatus(run()) });
      case "GET /api/player":
        return sendJson(res, 200, this.playerInfo());
      case "GET /api/player/stream":
        return this.openStream(req, res);
    }
    if (req.method !== "POST" || !url.pathname.startsWith("/api/player/")) throw new HttpError(404, "Unknown API route");
    const body = await readJson(req);
    const command = url.pathname.slice("/api/player/".length);
    if (command === "load") {
      const generation = Number(body.generation);
      if (typeof body.run !== "string" || !Number.isInteger(generation)) throw new HttpError(400, "Expected { run, generation }");
      await this.loadGeneration(body.run, generation);
      return sendJson(res, 200, this.playerInfo());
    }
    await this.enqueue(async () => {
      if (this.loaded === null) throw new HttpError(409, "No replay loaded");
      switch (command) {
        case "play":
          // Play from the start when finished, otherwise continue.
          if (this.player.isFinished()) {
            await this.player.start();
            this.resetSeq++;
          } else this.player.resume();
          break;
        case "pause":
          this.player.pause();
          break;
        case "resume":
          this.player.resume();
          break;
        case "restart":
          await this.player.start();
          this.resetSeq++;
          break;
        case "step": {
          const ticks = body.ticks === undefined ? 1 : Number(body.ticks);
          this.player.pause();
          if (!this.player.isFinished()) await this.player.stepForward(ticks);
          break;
        }
        case "speed":
          this.player.setPlaybackSpeed(Number(body.speed));
          break;
        default:
          throw new HttpError(404, `Unknown player command "${command}"`);
      }
      this.lastClock = performance.now();
      this.broadcast(true);
    });
    return sendJson(res, 200, this.playerInfo());
  }

  private playerInfo(): { loaded: LoadedReplayInfo | null; frame: unknown } {
    return { loaded: this.loaded, frame: JSON.parse(this.frameMessage()) as unknown };
  }

  private openStream(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${this.frameMessage()}\n\n`);
    this.clients.add(res);
    req.on("close", () => this.clients.delete(res));
  }

  private sendFile(res: ServerResponse, root: string, urlPath: string): void {
    const base = normalize(root + sep);
    const file = normalize(join(base, decodeURIComponent(urlPath)));
    if (!file.startsWith(base) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    createReadStream(file).pipe(res);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(400, "Expected a JSON object");
  return parsed as Record<string, unknown>;
}

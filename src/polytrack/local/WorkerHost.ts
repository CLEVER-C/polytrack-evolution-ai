/**
 * Runs the unmodified PolyTrack simulation worker (simulation_worker.bundle.js,
 * lib/polytrack_physics.js, polytrack_physics.wasm) inside an isolated Node
 * `vm` context that provides the handful of Web Worker globals it uses.
 *
 * Nothing in the game files is changed. The host only:
 * - implements `importScripts`, `postMessage`, `self`, timers and `performance`;
 * - hands the WASM bytes to the Emscripten loader (`wasmBinary`) instead of fetching;
 * - keeps a reference to the physics module the worker creates, so callers can
 *   invoke its exported functions directly (e.g. `updateCarModel` per tick);
 * - counts calls to every time/randomness source, for determinism auditing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { GAME_DIR } from "./paths.js";

/** Subset of the Emscripten module object the worker uses. */
export interface PhysicsModule {
  ccall(name: string, returnType: string | null, argTypes: readonly string[], args: readonly unknown[]): unknown;
  readonly HEAPU8: Uint8Array;
  readonly HEAPF32: Float32Array;
}

/** Calls observed per source since the last `resetCounters()`. */
export type CallCounts = Record<string, number>;

/**
 * Clock sources exposed to the worker and physics. Defaults are the real
 * clocks; tests substitute frozen or erratic clocks to prove results do not
 * depend on time.
 */
export interface WorkerHostOptions {
  readonly dateNow?: () => number;
  readonly performanceNow?: () => number;
}

export interface WorkerMessage {
  readonly messageType: number;
  readonly [key: string]: unknown;
}

const WORKER_FILE = "simulation_worker.bundle.js";
const READY_TIMEOUT_MS = 20_000;

/** Installed inside the context before any game code runs. */
const INSTRUMENTATION = String.raw`(() => {
  const count = __hostCount;
  const originalRandom = Math.random;
  Math.random = function () { count("Math.random"); return originalRandom(); };
  Date.now = function () { count("Date.now"); return __hostDateNow(); };
  const instantiate = WebAssembly.instantiate;
  WebAssembly.instantiate = function (source, imports) {
    if (imports) {
      for (const mod of Object.keys(imports)) {
        for (const name of Object.keys(imports[mod])) {
          const fn = imports[mod][name];
          if (typeof fn === "function") {
            imports[mod][name] = function () { count("wasmImport:" + mod + "." + name); return fn.apply(this, arguments); };
          }
        }
      }
    }
    return instantiate.call(this, source, imports);
  };
})();`;

/** Wraps the loader's global so the worker's own `PolyTrackPhysics()` call gets our WASM bytes. */
const PHYSICS_WRAPPER = String.raw`(() => {
  const original = PolyTrackPhysics;
  PolyTrackPhysics = function (options) {
    return original(Object.assign({}, options, { wasmBinary: __hostWasmBinary })).then((m) => { __hostOnPhysics(m); return m; });
  };
})();`;

export class WorkerHost {
  private readonly context: vm.Context;
  private readonly sandbox: Record<string, unknown>;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly listeners = new Set<(message: WorkerMessage) => void>();
  private readonly counts: CallCounts = {};
  private physicsModule: PhysicsModule | null = null;
  private disposed = false;

  private constructor(options: WorkerHostOptions) {
    const dateNow = options.dateNow ?? Date.now;
    const performanceNow = options.performanceNow ?? (() => performance.now());
    const count = (name: string): void => {
      this.counts[name] = (this.counts[name] ?? 0) + 1;
    };
    const track = (t: NodeJS.Timeout): NodeJS.Timeout => (this.timers.add(t), t);
    const sandbox: Record<string, unknown> = {
      console,
      atob,
      btoa,
      TextDecoder,
      TextEncoder,
      URL,
      queueMicrotask,
      location: { href: `http://localhost/polytrack/${WORKER_FILE}` },
      performance: {
        now: () => {
          count("performance.now");
          return performanceNow();
        },
      },
      setTimeout: (fn: () => void, ms?: number) => {
        count("setTimeout");
        return track(setTimeout(fn, ms));
      },
      clearTimeout: (t: NodeJS.Timeout) => (this.timers.delete(t), clearTimeout(t)),
      setInterval: (fn: () => void, ms?: number) => {
        count("setInterval");
        return track(setInterval(() => !this.disposed && fn(), ms));
      },
      clearInterval: (t: NodeJS.Timeout) => (this.timers.delete(t), clearInterval(t)),
      addEventListener: () => {},
      postMessage: (message: WorkerMessage) => {
        for (const listener of this.listeners) listener(message);
      },
      importScripts: (...paths: string[]) => {
        for (const p of paths) this.runGameScript(p);
      },
      onmessage: null,
      __hostCount: count,
      __hostDateNow: dateNow,
      __hostWasmBinary: readFileSync(join(GAME_DIR, "polytrack_physics.wasm")),
      __hostOnPhysics: (m: PhysicsModule) => {
        this.physicsModule = m;
      },
    };
    sandbox.self = sandbox;
    this.sandbox = sandbox;
    this.context = vm.createContext(sandbox, { name: "polytrack-simulation-worker" });
    vm.runInContext(INSTRUMENTATION, this.context);
  }

  /** Loads the worker and waits until the physics is ready to receive messages. */
  static async create(options: WorkerHostOptions = {}): Promise<WorkerHost> {
    const host = new WorkerHost(options);
    host.runGameScript(WORKER_FILE);
    const queueingHandler = host.sandbox.onmessage;
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (host.sandbox.onmessage === queueingHandler || host.physicsModule === null) {
      if (Date.now() > deadline) throw new Error("PolyTrack simulation worker did not become ready (physics failed to load)");
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return host;
  }

  private runGameScript(relativePath: string): void {
    const file = join(GAME_DIR, relativePath);
    vm.runInContext(readFileSync(file, "utf8"), this.context, { filename: file });
    if (relativePath === "lib/polytrack_physics.js") vm.runInContext(PHYSICS_WRAPPER, this.context);
  }

  /** The physics module instance created by the worker (exports: updateCarModel, createCarModel, ...). */
  get physics(): PhysicsModule {
    if (this.physicsModule === null) throw new Error("Physics not loaded");
    return this.physicsModule;
  }

  /** Delivers a message to the worker's `onmessage` handler, synchronously. */
  post(message: WorkerMessage): void {
    if (this.disposed) throw new Error("WorkerHost is disposed");
    (this.sandbox.onmessage as (event: { data: WorkerMessage }) => void)({ data: message });
  }

  onMessage(listener: (message: WorkerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get callCounts(): Readonly<CallCounts> {
    return { ...this.counts };
  }

  resetCounters(): void {
    for (const key of Object.keys(this.counts)) delete this.counts[key];
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }
}

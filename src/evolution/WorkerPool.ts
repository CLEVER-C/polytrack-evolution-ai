/**
 * Evaluates a whole population, either in this thread or spread over
 * `worker_threads`. Every worker owns its own PolyTrack simulation (the
 * unmodified worker + WASM in its own V8 isolate); nothing mutable is shared.
 *
 * Results are returned indexed by individual, never by completion order, and
 * each episode depends only on its weights and the (fixed) settings, so the
 * outcome is identical for any number of workers. Only the scheduling differs.
 */
import { Worker } from "node:worker_threads";
import type { RoadGeometry } from "../environment/RoadGeometry.js";
import { EpisodeEvaluator, type EvaluationResult, type EvaluatorDependencies } from "./Evaluator.js";
import type { EvolutionConfig } from "./EvolutionConfig.js";

export interface PopulationEvaluator {
  /** Worker threads used (0 = evaluates in the calling thread). */
  readonly workers: number;
  /** Evaluates every weight vector; `onResult` is called as each one completes (in any order). */
  evaluateAll(weights: readonly Float64Array[], onResult?: (index: number, result: EvaluationResult) => void): Promise<EvaluationResult[]>;
  dispose(): Promise<void>;
}

/** Messages between the pool and evaluationWorker.ts. */
export type WorkerRequest = { readonly type: "evaluate"; readonly index: number; readonly weights: Float64Array };
export type WorkerResponse =
  | { readonly type: "ready" }
  | { readonly type: "result"; readonly index: number; readonly result: EvaluationResult }
  | { readonly type: "error"; readonly index: number | null; readonly message: string };

export interface WorkerInit {
  readonly config: EvolutionConfig;
  readonly deps: EvaluatorDependencies;
  /** The road, already built by the main thread (plain data; rebuilt into a RoadGeometry in the worker). */
  readonly road: Pick<RoadGeometry, "samples" | "sections" | "spacing" | "up" | "options"> | null;
}

/**
 * Sequential evaluation in the calling thread. One simulation is reused for the
 * whole population and released afterwards, so nothing stays alive between generations.
 */
export class InProcessEvaluator implements PopulationEvaluator {
  readonly workers = 0;
  private readonly evaluator: EpisodeEvaluator;

  constructor(config: EvolutionConfig, deps: EvaluatorDependencies) {
    this.evaluator = new EpisodeEvaluator(config, deps, { reuseSimulation: true });
  }

  async evaluateAll(weights: readonly Float64Array[], onResult?: (index: number, result: EvaluationResult) => void): Promise<EvaluationResult[]> {
    const results: EvaluationResult[] = [];
    try {
      for (let i = 0; i < weights.length; i++) {
        const result = await this.evaluator.evaluate(weights[i]!);
        results.push(result);
        onResult?.(i, result);
      }
    } finally {
      await this.evaluator.dispose();
    }
    return results;
  }

  async dispose(): Promise<void> {
    await this.evaluator.dispose();
  }
}

const WORKER_URL = new URL("./evaluationWorker.js", import.meta.url);

/** A fixed pool of worker threads; each takes the next unevaluated individual when it becomes free. */
export class WorkerPoolEvaluator implements PopulationEvaluator {
  private busy = false;
  private failure: Error | null = null;

  private constructor(private readonly pool: Worker[]) {}

  get workers(): number {
    return this.pool.length;
  }

  static async create(config: EvolutionConfig, deps: EvaluatorDependencies, workers: number, road: RoadGeometry | null = null): Promise<WorkerPoolEvaluator> {
    if (!Number.isInteger(workers) || workers < 1) throw new Error(`workers must be an integer ≥ 1, got ${workers}`);
    const init: WorkerInit = { config, deps, road: road === null ? null : { samples: road.samples, sections: road.sections, spacing: road.spacing, up: road.up, options: road.options } };
    const pool = await Promise.all(
      Array.from({ length: workers }, () => {
        const worker = new Worker(WORKER_URL, { workerData: init });
        return new Promise<Worker>((resolve, reject) => {
          const onMessage = (m: WorkerResponse): void => {
            if (m.type === "ready") {
              worker.off("error", reject);
              resolve(worker);
            } else if (m.type === "error") reject(new Error(`Evaluation worker failed to start: ${m.message}`));
          };
          worker.once("message", onMessage);
          worker.once("error", reject);
        });
      }),
    );
    return new WorkerPoolEvaluator(pool);
  }

  evaluateAll(weights: readonly Float64Array[], onResult?: (index: number, result: EvaluationResult) => void): Promise<EvaluationResult[]> {
    if (this.busy) return Promise.reject(new Error("evaluateAll is already running"));
    if (this.failure !== null) return Promise.reject(this.failure);
    this.busy = true;
    const results: (EvaluationResult | undefined)[] = new Array(weights.length);
    let next = 0;
    let done = 0;
    return new Promise<EvaluationResult[]>((resolve, reject) => {
      const cleanups: (() => void)[] = [];
      const finish = (err: Error | null): void => {
        for (const c of cleanups) c();
        this.busy = false;
        if (err !== null) {
          this.failure = err;
          reject(err);
        } else resolve(results as EvaluationResult[]);
      };
      const dispatch = (worker: Worker): void => {
        if (next >= weights.length) return;
        const index = next++;
        const request: WorkerRequest = { type: "evaluate", index, weights: weights[index]! };
        worker.postMessage(request);
      };
      for (const worker of this.pool) {
        const onMessage = (m: WorkerResponse): void => {
          if (m.type === "result") {
            results[m.index] = m.result;
            done++;
            onResult?.(m.index, m.result);
            if (done === weights.length) finish(null);
            else dispatch(worker);
          } else if (m.type === "error") {
            finish(new Error(`Evaluation of individual ${m.index} failed: ${m.message}`));
          }
        };
        const onError = (err: Error): void => finish(err);
        const onExit = (code: number): void => finish(new Error(`Evaluation worker exited with code ${code}`));
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.on("exit", onExit);
        cleanups.push(() => {
          worker.off("message", onMessage);
          worker.off("error", onError);
          worker.off("exit", onExit);
        });
      }
      if (weights.length === 0) return finish(null);
      for (const worker of this.pool) dispatch(worker);
    });
  }

  async dispose(): Promise<void> {
    await Promise.all(this.pool.map((w) => w.terminate()));
    this.pool.length = 0;
  }
}

/** `workers` = 0: evaluate in this thread; ≥ 1: a worker-thread pool of that size. */
export async function createPopulationEvaluator(config: EvolutionConfig, deps: EvaluatorDependencies, workers: number, road: RoadGeometry | null = null): Promise<PopulationEvaluator> {
  return workers === 0 ? new InProcessEvaluator(config, deps) : WorkerPoolEvaluator.create(config, deps, workers, road);
}

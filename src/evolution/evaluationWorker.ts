/**
 * Worker-thread entry for WorkerPoolEvaluator: owns one PolyTrack simulation
 * and evaluates the individuals it is sent, one at a time.
 */
import { parentPort, workerData } from "node:worker_threads";
import { EpisodeEvaluator } from "./Evaluator.js";
import type { WorkerInit, WorkerRequest, WorkerResponse } from "./WorkerPool.js";

const port = parentPort;
if (port === null) throw new Error("evaluationWorker must run in a worker thread");
const post = (m: WorkerResponse): void => port.postMessage(m);

try {
  const { config, deps } = workerData as WorkerInit;
  const evaluator = new EpisodeEvaluator(config, deps, { reuseSimulation: true });
  port.on("message", (m: WorkerRequest) => {
    evaluator.evaluate(m.weights).then(
      (result) => post({ type: "result", index: m.index, result }),
      (err: unknown) => post({ type: "error", index: m.index, message: err instanceof Error ? (err.stack ?? err.message) : String(err) }),
    );
  });
  post({ type: "ready" });
} catch (err) {
  post({ type: "error", index: null, message: err instanceof Error ? (err.stack ?? err.message) : String(err) });
}

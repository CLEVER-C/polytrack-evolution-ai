import { NotImplementedError } from "../errors.js";
import type { NetworkTopology, NeuralNetwork } from "./types.js";

/** Plain fully-connected feed-forward network. Placeholder. */
export class FeedForwardNetwork implements NeuralNetwork {
  constructor(readonly topology: NetworkTopology) {}

  get parameterCount(): number {
    throw new NotImplementedError("FeedForwardNetwork.parameterCount");
  }

  forward(_inputs: readonly number[]): number[] {
    throw new NotImplementedError("FeedForwardNetwork.forward");
  }

  getParameters(): Float64Array {
    throw new NotImplementedError("FeedForwardNetwork.getParameters");
  }

  setParameters(_parameters: ArrayLike<number>): void {
    throw new NotImplementedError("FeedForwardNetwork.setParameters");
  }
}

import type { ControlInput, Observation } from "../environment/types.js";

export type ActivationFunction = "tanh" | "sigmoid" | "relu" | "linear";

/** Shape of a fully-connected feed-forward network. */
export interface NetworkTopology {
  readonly inputSize: number;
  /** Sizes of hidden layers, in order. May be empty. */
  readonly hiddenLayers: readonly number[];
  readonly outputSize: number;
  readonly hiddenActivation: ActivationFunction;
  readonly outputActivation: ActivationFunction;
}

/**
 * A neural network whose parameters can be read and written as one flat
 * vector. The flat-vector view is what evolution operates on, so the evolution
 * layer never needs to know about layers or activations.
 */
export interface NeuralNetwork {
  readonly topology: NetworkTopology;
  /** Total number of weights + biases. */
  readonly parameterCount: number;
  forward(inputs: readonly number[]): number[];
  getParameters(): Float64Array;
  /** Must be given exactly `parameterCount` values. */
  setParameters(parameters: ArrayLike<number>): void;
}

/** Anything that can drive: takes an observation, returns controls. */
export interface Agent {
  readonly id: string;
  act(observation: Observation): ControlInput;
  /** Clear any per-episode internal state (no-op for stateless agents). */
  reset(): void;
}

/** Maps raw network outputs to discrete controls. */
export interface ActionDecoder {
  /** Number of network outputs this decoder expects. */
  readonly outputSize: number;
  decode(outputs: readonly number[]): ControlInput;
}

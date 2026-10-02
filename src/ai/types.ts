import type { Observation } from "../environment/types.js";

export type ActivationFunction = "tanh" | "sigmoid" | "relu" | "linear";

export interface LayerDefinition {
  readonly size: number;
  readonly activation: ActivationFunction;
}

/** One named output neuron with its own activation (so each output can have its own range). */
export interface OutputDefinition {
  readonly name: string;
  readonly activation: ActivationFunction;
}

/** Shape of a fully-connected feed-forward network. */
export interface NetworkArchitecture {
  readonly inputSize: number;
  /** Hidden layers in order. May be empty. */
  readonly hiddenLayers: readonly LayerDefinition[];
  readonly outputs: readonly OutputDefinition[];
}

/**
 * Continuous driving intent produced by an agent, clamped to valid ranges.
 * PolyTrack itself only accepts on/off keys; see `DrivingAgent.toControls`.
 */
export interface DrivingAction {
  /** -1 = full left … +1 = full right. */
  readonly steering: number;
  /** 0 … 1. */
  readonly throttle: number;
  /** 0 … 1. */
  readonly brake: number;
}

/** Anything that can drive: takes an observation, returns a driving action. */
export interface Agent {
  readonly id: string;
  act(observation: Observation): DrivingAction;
  /** Clear any per-episode internal state (no-op for stateless agents). */
  reset(): void;
}

/**
 * TrackObservation → NeuralNetwork → DrivingAction (→ PolyTrack controls).
 *
 * The agent contains no driving logic: every decision comes from the network
 * weights. It only (1) feeds the encoded observation to the network, (2) clamps
 * the outputs to valid ranges, and (3) maps the continuous action onto
 * PolyTrack's five on/off keys with fixed thresholds.
 */
import type { ControlInput, Observation } from "../environment/types.js";
import { NeuralNetwork } from "./NeuralNetwork.js";
import type { Agent, DrivingAction, NetworkArchitecture, OutputDefinition } from "./types.js";

/**
 * Output neurons, in order. Activations match each control's range:
 * - steering: tanh → (-1, 1), symmetric left/right, 0 = straight
 * - throttle, brake: sigmoid → (0, 1), "how strongly to press"
 */
export const DRIVING_OUTPUTS: readonly OutputDefinition[] = [
  { name: "steering", activation: "tanh" },
  { name: "throttle", activation: "sigmoid" },
  { name: "brake", activation: "sigmoid" },
];

/** Default hidden layers: two tanh layers of 24 neurons. */
export const DEFAULT_HIDDEN_LAYERS = [24, 24] as const;

/** Architecture for a driving network with `inputSize` observation features. */
export function drivingArchitecture(inputSize: number, hidden: readonly number[] = DEFAULT_HIDDEN_LAYERS): NetworkArchitecture {
  return {
    inputSize,
    hiddenLayers: hidden.map((size) => ({ size, activation: "tanh" as const })),
    outputs: DRIVING_OUTPUTS,
  };
}

export interface ControlMappingOptions {
  /** |steering| above this presses left/right. Default 0.25. */
  readonly steeringThreshold: number;
  /** throttle/brake above this presses the key. Default 0.5. */
  readonly pressThreshold: number;
}

export const DEFAULT_CONTROL_MAPPING: ControlMappingOptions = { steeringThreshold: 0.25, pressThreshold: 0.5 };

const clamp = (v: number, lo: number, hi: number): number => (Number.isNaN(v) ? 0 : Math.min(hi, Math.max(lo, v)));

/** Clamps raw network outputs to valid action ranges (NaN → 0). */
export function toDrivingAction(outputs: readonly number[]): DrivingAction {
  return {
    steering: clamp(outputs[0] ?? 0, -1, 1),
    throttle: clamp(outputs[1] ?? 0, 0, 1),
    brake: clamp(outputs[2] ?? 0, 0, 1),
  };
}

/**
 * PolyTrack accepts only digital keys (up/down/left/right), so the continuous
 * action is thresholded. Both throttle and brake may be pressed at once; the
 * physics decides what that does.
 */
export function toControls(action: DrivingAction, mapping: ControlMappingOptions = DEFAULT_CONTROL_MAPPING): ControlInput {
  return {
    accelerate: action.throttle > mapping.pressThreshold,
    brake: action.brake > mapping.pressThreshold,
    steerLeft: action.steering < -mapping.steeringThreshold,
    steerRight: action.steering > mapping.steeringThreshold,
  };
}

export interface DrivingDecision {
  /** Raw network outputs, in DRIVING_OUTPUTS order. */
  readonly outputs: readonly number[];
  readonly action: DrivingAction;
  readonly controls: ControlInput;
}

export class DrivingAgent implements Agent {
  constructor(
    readonly id: string,
    readonly network: NeuralNetwork,
    private readonly mapping: ControlMappingOptions = DEFAULT_CONTROL_MAPPING,
  ) {
    const names = network.outputNames;
    if (names.length !== DRIVING_OUTPUTS.length || names.some((n, i) => n !== DRIVING_OUTPUTS[i]!.name)) {
      throw new Error(`DrivingAgent needs outputs [${DRIVING_OUTPUTS.map((o) => o.name).join(", ")}], got [${names.join(", ")}]`);
    }
  }

  /** Network decision for an encoded observation, clamped to valid ranges. */
  act(observation: Observation): DrivingAction {
    return this.decide(observation).action;
  }

  /** Full decision: raw outputs, clamped action and the PolyTrack keys to press. */
  decide(observation: Observation): DrivingDecision {
    const outputs = this.network.predict(observation.features);
    const action = toDrivingAction(outputs);
    return { outputs, action, controls: toControls(action, this.mapping) };
  }

  reset(): void {
    // Stateless: decisions depend only on the current observation.
  }
}

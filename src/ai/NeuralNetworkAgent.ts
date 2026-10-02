import type { ControlInput, Observation } from "../environment/types.js";
import { NotImplementedError } from "../errors.js";
import type { ActionDecoder, Agent, NeuralNetwork } from "./types.js";

/** An Agent whose policy is a NeuralNetwork. Placeholder. */
export class NeuralNetworkAgent implements Agent {
  constructor(
    readonly id: string,
    readonly network: NeuralNetwork,
    private readonly decoder: ActionDecoder,
  ) {}

  act(_observation: Observation): ControlInput {
    throw new NotImplementedError("NeuralNetworkAgent.act");
  }

  reset(): void {
    throw new NotImplementedError("NeuralNetworkAgent.reset");
  }
}

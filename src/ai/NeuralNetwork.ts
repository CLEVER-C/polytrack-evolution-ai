/**
 * Small, dependency-free, fully-connected feed-forward neural network whose
 * parameters live in one flat Float64Array — the representation the
 * evolutionary phase will mutate.
 *
 * Flat weight layout, layer by layer (hidden layers first, then the output layer):
 *   weights[out][in] row-major (out × in values), then biases[out] (out values).
 *
 * Inference is plain JavaScript double-precision arithmetic in a fixed order,
 * so the same weights + the same inputs always give the same outputs.
 */
import { readFile, writeFile } from "node:fs/promises";
import { seededRandom, type RandomSource } from "./random.js";
import type { ActivationFunction, NetworkArchitecture } from "./types.js";

export const SERIALIZATION_FORMAT = "polytrack-evolution-ai/neural-network";
export const SERIALIZATION_VERSION = 1;

/** JSON form of a network. Weights are plain numbers; JSON round-trips doubles exactly. */
export interface SerializedNetwork {
  readonly format: typeof SERIALIZATION_FORMAT;
  readonly version: typeof SERIALIZATION_VERSION;
  readonly architecture: NetworkArchitecture;
  readonly weights: number[];
}

const ACTIVATIONS: Record<ActivationFunction, (x: number) => number> = {
  tanh: Math.tanh,
  sigmoid: (x) => 1 / (1 + Math.exp(-x)),
  relu: (x) => (x > 0 ? x : 0),
  linear: (x) => x,
};

interface Layer {
  readonly inputs: number;
  readonly outputs: number;
  /** Offset of this layer's weights in the flat array; biases follow at offset + inputs × outputs. */
  readonly offset: number;
  /** One activation per output neuron. */
  readonly activations: readonly ((x: number) => number)[];
}

function buildLayers(arch: NetworkArchitecture): Layer[] {
  if (!Number.isInteger(arch.inputSize) || arch.inputSize < 1) throw new Error(`Invalid inputSize ${arch.inputSize}`);
  if (arch.outputs.length < 1) throw new Error("Network needs at least one output");
  const specs = [
    ...arch.hiddenLayers.map((l) => {
      if (!Number.isInteger(l.size) || l.size < 1) throw new Error(`Invalid hidden layer size ${l.size}`);
      return Array<ActivationFunction>(l.size).fill(l.activation);
    }),
    arch.outputs.map((o) => o.activation),
  ];
  const layers: Layer[] = [];
  let inputs = arch.inputSize;
  let offset = 0;
  for (const activations of specs) {
    for (const a of activations) if (!(a in ACTIVATIONS)) throw new Error(`Unknown activation "${a}"`);
    layers.push({ inputs, outputs: activations.length, offset, activations: activations.map((a) => ACTIVATIONS[a]) });
    offset += inputs * activations.length + activations.length;
    inputs = activations.length;
  }
  return layers;
}

export interface CreateNetworkOptions {
  /** Seed for reproducible initialization. Ignored when `random` is given. */
  readonly seed?: number;
  readonly random?: RandomSource;
}

export class NeuralNetwork {
  readonly parameterCount: number;
  private readonly layers: readonly Layer[];
  private readonly weights: Float64Array;
  /** Reused activation buffers (one per layer) so predict() does not allocate per layer. */
  private readonly buffers: Float64Array[];

  private constructor(
    readonly architecture: NetworkArchitecture,
    weights: Float64Array,
  ) {
    this.layers = buildLayers(architecture);
    const last = this.layers[this.layers.length - 1]!;
    this.parameterCount = last.offset + last.inputs * last.outputs + last.outputs;
    if (weights.length !== this.parameterCount) throw new Error(`Expected ${this.parameterCount} weights, got ${weights.length}`);
    this.weights = weights;
    this.buffers = this.layers.map((l) => new Float64Array(l.outputs));
  }

  /** Number of trainable parameters (weights + biases) for an architecture. */
  static parameterCount(architecture: NetworkArchitecture): number {
    const layers = buildLayers(architecture);
    const last = layers[layers.length - 1]!;
    return last.offset + last.inputs * last.outputs + last.outputs;
  }

  /**
   * New network with Glorot/Xavier-uniform weights (limit √(6 / (fanIn + fanOut)),
   * suited to tanh/sigmoid) and zero biases.
   */
  static create(architecture: NetworkArchitecture, options: CreateNetworkOptions = {}): NeuralNetwork {
    const random = options.random ?? seededRandom(options.seed ?? Date.now());
    const layers = buildLayers(architecture);
    const last = layers[layers.length - 1]!;
    const weights = new Float64Array(last.offset + last.inputs * last.outputs + last.outputs);
    for (const layer of layers) {
      const limit = Math.sqrt(6 / (layer.inputs + layer.outputs));
      for (let i = 0; i < layer.inputs * layer.outputs; i++) weights[layer.offset + i] = (random() * 2 - 1) * limit;
      // biases stay 0
    }
    return new NeuralNetwork(architecture, weights);
  }

  /** Network with the given flat weights (copied). */
  static fromWeights(architecture: NetworkArchitecture, weights: ArrayLike<number>): NeuralNetwork {
    const net = new NeuralNetwork(architecture, new Float64Array(NeuralNetwork.parameterCount(architecture)));
    net.setWeights(weights);
    return net;
  }

  get inputSize(): number {
    return this.architecture.inputSize;
  }

  get outputNames(): string[] {
    return this.architecture.outputs.map((o) => o.name);
  }

  /** Forward propagation. Returns one value per output, in architecture order. */
  predict(inputs: ArrayLike<number>): number[] {
    if (inputs.length !== this.architecture.inputSize) {
      throw new Error(`Expected ${this.architecture.inputSize} inputs, got ${inputs.length}`);
    }
    const w = this.weights;
    let source: ArrayLike<number> = inputs;
    for (let l = 0; l < this.layers.length; l++) {
      const { inputs: n, outputs: m, offset, activations } = this.layers[l]!;
      const out = this.buffers[l]!;
      const biasOffset = offset + n * m;
      for (let j = 0; j < m; j++) {
        let sum = w[biasOffset + j]!;
        const row = offset + j * n;
        for (let i = 0; i < n; i++) sum += w[row + i]! * source[i]!;
        out[j] = activations[j]!(sum);
      }
      source = out;
    }
    return Array.from(source);
  }

  /** Copy of all parameters as one flat array (layout: see file header). */
  getWeights(): Float64Array {
    return this.weights.slice();
  }

  /** Replaces all parameters. Must be exactly `parameterCount` finite numbers. */
  setWeights(weights: ArrayLike<number>): void {
    if (weights.length !== this.parameterCount) throw new Error(`Expected ${this.parameterCount} weights, got ${weights.length}`);
    for (let i = 0; i < weights.length; i++) {
      const v = weights[i]!;
      if (!Number.isFinite(v)) throw new Error(`Weight ${i} is not finite (${v})`);
      this.weights[i] = v;
    }
  }

  /** Independent copy (same architecture and weights). */
  clone(): NeuralNetwork {
    return new NeuralNetwork(this.architecture, this.weights.slice());
  }

  serialize(): SerializedNetwork {
    return { format: SERIALIZATION_FORMAT, version: SERIALIZATION_VERSION, architecture: this.architecture, weights: Array.from(this.weights) };
  }

  static deserialize(data: SerializedNetwork | string): NeuralNetwork {
    const parsed = (typeof data === "string" ? JSON.parse(data) : data) as Partial<SerializedNetwork>;
    if (parsed.format !== SERIALIZATION_FORMAT) throw new Error(`Not a serialized network (format ${String(parsed.format)})`);
    if (parsed.version !== SERIALIZATION_VERSION) throw new Error(`Unsupported network version ${String(parsed.version)}`);
    if (parsed.architecture === undefined || !Array.isArray(parsed.weights)) throw new Error("Serialized network is missing fields");
    return NeuralNetwork.fromWeights(parsed.architecture, parsed.weights);
  }

  async save(path: string): Promise<void> {
    await writeFile(path, JSON.stringify(this.serialize()));
  }

  static async load(path: string): Promise<NeuralNetwork> {
    return NeuralNetwork.deserialize(await readFile(path, "utf8"));
  }
}

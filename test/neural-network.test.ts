/** NeuralNetwork unit tests (no game data needed). */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { drivingArchitecture } from "../src/ai/DrivingAgent.js";
import { NeuralNetwork } from "../src/ai/NeuralNetwork.js";
import { seededRandom } from "../src/ai/random.js";
import type { NetworkArchitecture } from "../src/ai/types.js";

const TINY: NetworkArchitecture = {
  inputSize: 2,
  hiddenLayers: [{ size: 2, activation: "linear" }],
  outputs: [
    { name: "a", activation: "linear" },
    { name: "b", activation: "sigmoid" },
  ],
};

describe("NeuralNetwork", () => {
  test("parameter count of the 47-24-24-3 driving network is 1827", () => {
    const arch = drivingArchitecture(47);
    assert.equal(NeuralNetwork.parameterCount(arch), 47 * 24 + 24 + 24 * 24 + 24 + 24 * 3 + 3);
    assert.equal(NeuralNetwork.parameterCount(arch), 1827);
    assert.equal(NeuralNetwork.create(arch, { seed: 1 }).parameterCount, 1827);
  });

  test("forward propagation matches a hand computation (weight layout: rows then biases)", () => {
    // hidden: h0 = 1·x0 + 2·x1 + 0.5,  h1 = -1·x0 + 3·x1 - 1   (linear)
    // output: a = 1·h0 + 1·h1 + 0 (linear),  b = sigmoid(0.5·h0 - 0.5·h1 + 0.25)
    const net = NeuralNetwork.fromWeights(TINY, [1, 2, -1, 3, 0.5, -1, 1, 1, 0.5, -0.5, 0, 0.25]);
    const [x0, x1] = [0.3, -0.7];
    const h0 = x0 + 2 * x1 + 0.5;
    const h1 = -x0 + 3 * x1 - 1;
    const [a, b] = net.predict([x0, x1]);
    assert.equal(a, h0 + h1);
    assert.equal(b, 1 / (1 + Math.exp(-(0.5 * h0 - 0.5 * h1 + 0.25))));
  });

  test("activations: tanh, sigmoid, relu, linear", () => {
    const arch = (activation: "tanh" | "sigmoid" | "relu" | "linear"): NetworkArchitecture => ({ inputSize: 1, hiddenLayers: [], outputs: [{ name: "y", activation }] });
    const out = (activation: Parameters<typeof arch>[0], x: number) => NeuralNetwork.fromWeights(arch(activation), [1, 0]).predict([x])[0]!;
    assert.equal(out("tanh", 0.8), Math.tanh(0.8));
    assert.equal(out("sigmoid", 0), 0.5);
    assert.equal(out("relu", -2), 0);
    assert.equal(out("relu", 2), 2);
    assert.equal(out("linear", -3.5), -3.5);
  });

  test("random initialization is seeded, Glorot-bounded, with zero biases", () => {
    const arch = drivingArchitecture(47);
    const a = NeuralNetwork.create(arch, { seed: 42 }).getWeights();
    assert.deepEqual(NeuralNetwork.create(arch, { seed: 42 }).getWeights(), a);
    assert.notDeepEqual(NeuralNetwork.create(arch, { seed: 43 }).getWeights(), a);
    const layers: [number, number][] = [[47, 24], [24, 24], [24, 3]];
    let offset = 0;
    for (const [n, m] of layers) {
      const limit = Math.sqrt(6 / (n + m));
      for (let i = 0; i < n * m; i++) assert.ok(Math.abs(a[offset + i]!) <= limit);
      for (let j = 0; j < m; j++) assert.equal(a[offset + n * m + j], 0);
      offset += n * m + m;
    }
    assert.equal(offset, a.length);
  });

  test("getWeights() returns a copy; setWeights() replaces all weights and validates", () => {
    const net = NeuralNetwork.create(drivingArchitecture(47), { seed: 7 });
    const w = net.getWeights();
    w[0] = 123;
    assert.notEqual(net.getWeights()[0], 123);
    const rand = seededRandom(99);
    const replacement = Array.from({ length: net.parameterCount }, () => rand() - 0.5);
    net.setWeights(replacement);
    assert.deepEqual(Array.from(net.getWeights()), replacement);
    assert.throws(() => net.setWeights(replacement.slice(1)), /Expected 1827 weights/);
    assert.throws(() => net.setWeights([...replacement.slice(1), Number.NaN]), /not finite/);
  });

  test("clone() is independent and predicts identically", () => {
    const net = NeuralNetwork.create(drivingArchitecture(5), { seed: 3 });
    const copy = net.clone();
    const x = [0.1, -0.2, 0.3, -0.4, 0.5];
    assert.deepEqual(copy.predict(x), net.predict(x));
    copy.setWeights(new Float64Array(copy.parameterCount).fill(0.01));
    assert.notDeepEqual(copy.predict(x), net.predict(x));
    assert.deepEqual(net.predict(x), NeuralNetwork.create(drivingArchitecture(5), { seed: 3 }).predict(x));
  });

  test("serialize/deserialize and save/load round-trip weights bit-exactly", async () => {
    const net = NeuralNetwork.create(drivingArchitecture(47), { seed: 11 });
    const x = Array.from({ length: 47 }, (_, i) => Math.sin(i));
    const viaObject = NeuralNetwork.deserialize(net.serialize());
    const viaString = NeuralNetwork.deserialize(JSON.stringify(net.serialize()));
    assert.deepEqual(viaObject.getWeights(), net.getWeights());
    assert.deepEqual(viaString.getWeights(), net.getWeights());
    assert.deepEqual(viaString.predict(x), net.predict(x));
    const dir = await mkdtemp(join(tmpdir(), "nn-"));
    try {
      await net.save(join(dir, "net.json"));
      const loaded = await NeuralNetwork.load(join(dir, "net.json"));
      assert.deepEqual(loaded.architecture, net.architecture);
      assert.deepEqual(loaded.getWeights(), net.getWeights());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    assert.throws(() => NeuralNetwork.deserialize({ ...net.serialize(), format: "x" } as never), /Not a serialized network/);
  });

  test("inference is deterministic and validates input size", () => {
    const net = NeuralNetwork.create(drivingArchitecture(47), { seed: 5 });
    const x = Array.from({ length: 47 }, (_, i) => (i % 7) / 7 - 0.5);
    const first = net.predict(x);
    for (let i = 0; i < 100; i++) assert.deepEqual(net.predict(x), first);
    assert.throws(() => net.predict(x.slice(1)), /Expected 47 inputs/);
  });
});

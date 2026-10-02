/**
 * Verifies that the local PolyTrack 0.6.3 physics runs outside the browser and
 * is deterministic.
 *
 *   npm run verify:simulation
 *
 * Capability checks: initialize, single-tick stepping, controlled inputs,
 * reset (restart + reset key), state query.
 * Determinism checks: the same initial state + the same input sequence is run
 * under different conditions and every tick's raw state bytes are compared.
 *
 * Writes a JSON report to data/verification/simulation-report.json.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PolyTrackControls } from "../src/polytrack/PolyTrackInterface.js";
import { loadCapturedInit, loadCapturedTrack, type CapturedInit, type CapturedTrack } from "../src/polytrack/local/capture.js";
import { decodeCarBuffer } from "../src/polytrack/local/carState.js";
import { LocalSimulation } from "../src/polytrack/local/LocalSimulation.js";
import { encodeRecording } from "../src/polytrack/local/recording.js";
import {
  GAME_DIR,
  INIT_CAPTURE_PATH,
  MANIFEST_PATH,
  POLYTRACK_LOCAL_VERSION,
  PROJECT_ROOT,
  TRACKS_CAPTURE_DIR,
  type Manifest,
} from "../src/polytrack/local/paths.js";
import type { WorkerHostOptions } from "../src/polytrack/local/WorkerHost.js";

const TRACK = "summer1";
const EXTRA_TRACKS = ["winter1", "desert1"];
const FRAMES = 20_000; // 20 s of game time at 1 ms per tick
const SEED = 0x5eed1234;
const CHECKPOINT_TRACK = "summer6";
const CHECKPOINT_FRAMES = 10_000;
const RESPAWN_AT = 6_000;
const REPORT_PATH = join(PROJECT_ROOT, "data", "verification", "simulation-report.json");

const NONE: PolyTrackControls = { up: false, right: false, down: false, left: false, reset: false };

// ───────────────────────────── helpers ─────────────────────────────

/** Small deterministic PRNG (mulberry32) so input sequences are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Held-key segments of 50–800 ticks: mostly throttle, with braking and steering. Never presses reset. */
function generateInputs(seed: number, frames: number): PolyTrackControls[] {
  const rand = prng(seed);
  const out: PolyTrackControls[] = [];
  while (out.length < frames) {
    const steer = rand();
    const controls: PolyTrackControls = {
      up: rand() < 0.75,
      down: rand() < 0.12,
      left: steer < 0.3,
      right: steer > 0.7,
      reset: false,
    };
    const hold = 50 + Math.floor(rand() * 750);
    for (let i = 0; i < hold && out.length < frames; i++) out.push(controls);
  }
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Flattens a decoded state into path → value for field-level diffs. */
function flatten(value: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

interface Comparison {
  readonly name: string;
  readonly description: string;
  readonly ticksCompared: number;
  readonly identical: boolean;
  /** 0-based tick index of the first mismatch. */
  readonly firstDivergence: number | null;
  readonly differingFields: readonly { field: string; reference: unknown; other: unknown }[];
}

function compareStreams(name: string, description: string, reference: readonly Uint8Array[], other: readonly Uint8Array[]): Comparison {
  const n = Math.min(reference.length, other.length);
  for (let i = 0; i < n; i++) {
    if (!bytesEqual(reference[i]!, other[i]!)) {
      const a = flatten(decodeState(reference[i]!));
      const b = flatten(decodeState(other[i]!));
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const differingFields = keys.filter((k) => !Object.is(a[k], b[k])).map((k) => ({ field: k, reference: a[k], other: b[k] }));
      return { name, description, ticksCompared: n, identical: false, firstDivergence: i, differingFields };
    }
  }
  const lengthMismatch = reference.length !== other.length;
  return {
    name,
    description,
    ticksCompared: n,
    identical: !lengthMismatch,
    firstDivergence: lengthMismatch ? n : null,
    differingFields: lengthMismatch ? [{ field: "streamLength", reference: reference.length, other: other.length }] : [],
  };
}

/** Raw bytes include the carId prefix; strip it so streams from different car ids are comparable. */
function withoutCarId(raw: Uint8Array): Uint8Array {
  return raw.subarray(4);
}

/** Decodes a CarState whose carId prefix was stripped. */
function decodeState(state: Uint8Array) {
  const buf = new Uint8Array(4 + state.length);
  buf.set(state, 4);
  return decodeCarBuffer(buf).state;
}

async function runDirect(
  init: CapturedInit,
  track: CapturedTrack,
  inputs: readonly PolyTrackControls[],
  hostOptions: WorkerHostOptions = {},
): Promise<{ states: Uint8Array[]; counts: Record<string, number>; ticksPerSecond: number }> {
  const sim = await LocalSimulation.create(init, hostOptions);
  try {
    const car = sim.createCar(track);
    sim.host.resetCounters();
    const t0 = performance.now();
    const states = inputs.map((c) => withoutCarId(sim.step(car, c).raw).slice());
    const elapsed = performance.now() - t0;
    return { states, counts: { ...sim.host.callCounts }, ticksPerSecond: Math.round(inputs.length / (elapsed / 1000)) };
  } finally {
    sim.dispose();
  }
}

// ───────────────────────────── child mode ─────────────────────────────

/** `--child <track> <seed> <frames>`: run in a separate OS process, print per-tick hashes. */
async function childMain(args: string[]): Promise<void> {
  const [trackName, seed, frames] = [args[0]!, Number(args[1]), Number(args[2])];
  const { states } = await runDirect(await loadCapturedInit(), await loadCapturedTrack(trackName), generateInputs(seed, frames));
  process.stdout.write(JSON.stringify(states.map(sha256)));
}

// ───────────────────────────── prerequisites ─────────────────────────────

async function checkPrerequisites(): Promise<string[]> {
  const problems: string[] = [];
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  for (const path of ["simulation_worker.bundle.js", "lib/polytrack_physics.js", "polytrack_physics.wasm"]) {
    const entry = manifest.files.find((f) => f.path === path);
    const file = join(GAME_DIR, path);
    if (!existsSync(file)) problems.push(`missing ${file}`);
    else if (entry?.sha256 !== sha256(new Uint8Array(await readFile(file)))) problems.push(`${path} does not match the pinned ${POLYTRACK_LOCAL_VERSION} hash`);
  }
  if (!existsSync(INIT_CAPTURE_PATH)) problems.push(`missing ${INIT_CAPTURE_PATH}`);
  if (!existsSync(join(TRACKS_CAPTURE_DIR, `${TRACK}.json`))) problems.push(`missing captured track ${TRACK}`);
  return problems;
}

// ───────────────────────────── main ─────────────────────────────

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function main(): Promise<void> {
  const problems = await checkPrerequisites();
  if (problems.length > 0) {
    console.error("Local PolyTrack files are not set up:\n  " + problems.join("\n  "));
    console.error("Run: npm run setup:polytrack");
    process.exit(2);
  }

  const init = await loadCapturedInit();
  const track = await loadCapturedTrack(TRACK);
  const inputs = generateInputs(SEED, FRAMES);
  const checks: Check[] = [];
  const observations: Record<string, unknown> = {};
  const fmt = (v: { x: number; y: number; z: number }): string => `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;

  console.log(`PolyTrack ${POLYTRACK_LOCAL_VERSION} local simulation verification`);
  console.log(`Track: ${track.name} (${TRACK}) · ${FRAMES} ticks · input seed 0x${SEED.toString(16)}\n`);

  // ── 1. Initialize ──
  const t0 = performance.now();
  const sim = await LocalSimulation.create(init);
  const loadCounts = { ...sim.host.callCounts };
  checks.push({ name: "initialize", ok: true, detail: `worker + physics loaded and Init accepted in ${(performance.now() - t0).toFixed(0)} ms (${init.trackParts.length} track part configs)` });
  checks.push({ name: "builtin determinism self-test", ok: sim.testDeterminism(), detail: "TestDeterminism message → physics testDeterminism()" });

  // ── 2. Single tick + state query ──
  const car = sim.createCar(track);
  const s1 = sim.step(car, NONE).decoded.state;
  const s2 = sim.step(car, NONE).decoded.state;
  const start = track.startTransform!.position;
  const startErr = Math.max(Math.abs(s1.position.x - start.x), Math.abs(s1.position.y - start.y), Math.abs(s1.position.z - start.z));
  checks.push({ name: "step one tick", ok: s2.frames === s1.frames + 1, detail: `frames ${s1.frames} → ${s2.frames} per updateCarModel call` });
  checks.push({ name: "query state", ok: startErr < 1e-3 && Math.abs(Math.hypot(s1.quaternion.x, s1.quaternion.y, s1.quaternion.z, s1.quaternion.w) - 1) < 1e-5, detail: `first state at ${fmt(s1.position)}, captured start ${fmt(start)}, hasStarted=${s1.hasStarted}` });
  sim.deleteCar(car);

  // ── 3. Controlled inputs ──
  const drive = (controls: PolyTrackControls, ticks: number) => {
    const id = sim.createCar(track);
    let s = sim.step(id, controls).decoded.state;
    for (let i = 1; i < ticks; i++) s = sim.step(id, controls).decoded.state;
    sim.deleteCar(id);
    return s;
  };
  const idle = drive(NONE, 2000);
  const gas = drive({ ...NONE, up: true }, 2000);
  const gasLeft = drive({ ...NONE, up: true, left: true }, 2000);
  const gasRight = drive({ ...NONE, up: true, right: true }, 2000);
  checks.push({
    name: "controlled inputs",
    ok: gas.speedKmh > idle.speedKmh + 10 && gasLeft.steering !== gasRight.steering && Math.sign(gasLeft.steering) === -Math.sign(gasRight.steering),
    detail: `after 2 s: idle ${idle.speedKmh.toFixed(2)} km/h, up ${gas.speedKmh.toFixed(2)} km/h; steering up+left ${gasLeft.steering.toFixed(3)}, up+right ${gasRight.steering.toFixed(3)}`,
  });

  // ── 4a. Reset by restart (DeleteCar + CreateCar) ──
  const restartLen = 5000;
  const first = sim.createCar(track);
  for (const c of inputs.slice(0, restartLen)) sim.step(first, c);
  sim.deleteCar(first);
  const second = sim.createCar(track);
  const afterRestart = inputs.slice(0, restartLen).map((c) => withoutCarId(sim.step(second, c).raw).slice());
  sim.deleteCar(second);

  // ── 4b. Reset key behaviour (observed, not asserted) ──
  const rk = sim.createCar(track);
  let beforeReset = sim.step(rk, { ...NONE, up: true }).decoded.state;
  for (let i = 1; i < 3000; i++) beforeReset = sim.step(rk, { ...NONE, up: true }).decoded.state;
  const onReset = sim.step(rk, { ...NONE, reset: true }).decoded.state;
  let afterReset = onReset;
  for (let i = 0; i < 10; i++) afterReset = sim.step(rk, NONE).decoded.state;
  sim.deleteCar(rk);
  const dist = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - start.x, p.y - start.y, p.z - start.z);
  observations.resetKey = {
    hasCheckpointToRespawnAt: beforeReset.hasCheckpointToRespawnAt,
    before: { frames: beforeReset.frames, speedKmh: beforeReset.speedKmh, distanceFromStart: dist(beforeReset.position) },
    resetTick: { frames: onReset.frames, speedKmh: onReset.speedKmh, distanceFromStart: dist(onReset.position) },
    tenTicksLater: { frames: afterReset.frames, speedKmh: afterReset.speedKmh, distanceFromStart: dist(afterReset.position) },
  };
  sim.dispose();

  // ── 5. Determinism ──
  console.log("Running determinism comparisons...");
  const reference = await runDirect(init, track, inputs);
  const comparisons: Comparison[] = [];

  comparisons.push(compareStreams("restart-in-same-instance", "car recreated after DeleteCar in the same physics instance vs fresh instance (first 5000 ticks)", reference.states.slice(0, restartLen), afterRestart));

  const repeat = await runDirect(init, track, inputs);
  comparisons.push(compareStreams("repeat-fresh-instance", "second run in a new isolated physics instance, same process", reference.states, repeat.states));

  // Two cars stepped alternately in one instance: does another car affect ours?
  {
    const shared = await LocalSimulation.create(init);
    const a = shared.createCar(track);
    const b = shared.createCar(track);
    const other = generateInputs(SEED ^ 0xffff, FRAMES);
    const states: Uint8Array[] = [];
    for (let i = 0; i < FRAMES; i++) {
      states.push(withoutCarId(shared.step(a, inputs[i]!).raw).slice());
      shared.step(b, other[i]!);
    }
    shared.dispose();
    comparisons.push(compareStreams("interleaved-second-car", "stepped alternately with a second car driving different inputs in the same instance", reference.states, states));
  }

  const frozen = await runDirect(init, track, inputs, { dateNow: () => 0, performanceNow: () => 0 });
  comparisons.push(compareStreams("frozen-clock", "Date.now() and performance.now() frozen at 0", reference.states, frozen.states));

  {
    const jitter = prng(0xc10c);
    const erratic = await runDirect(init, track, inputs, {
      dateNow: () => Math.floor(jitter() * 4e12),
      performanceNow: () => jitter() * 1e9,
    });
    comparisons.push(compareStreams("erratic-clock", "Date.now()/performance.now() return random values on every call", reference.states, erratic.states));
  }

  {
    const sim2 = await LocalSimulation.create(init);
    const id = sim2.createCar(track);
    const delay = prng(0xde1a);
    const states: Uint8Array[] = [];
    for (let i = 0; i < FRAMES; i++) {
      states.push(withoutCarId(sim2.step(id, inputs[i]!).raw).slice());
      if (i % 500 === 499) await new Promise((r) => setTimeout(r, Math.floor(delay() * 5)));
      if (i % 2000 === 1999) {
        const until = performance.now() + delay() * 20;
        while (performance.now() < until); // busy-wait to vary wall-clock gaps
      }
    }
    sim2.dispose();
    comparisons.push(compareStreams("wall-clock-gaps", "random sleeps and busy-waits between ticks (variable real frame rate)", reference.states, states));
  }

  {
    const thisFile = fileURLToPath(import.meta.url);
    const child = spawnSync(process.execPath, [thisFile, "--child", TRACK, String(SEED), String(FRAMES)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (child.status !== 0) throw new Error(`child process failed: ${child.stderr}`);
    const childHashes = JSON.parse(child.stdout) as string[];
    const refHashes = reference.states.map(sha256);
    const firstDiff = refHashes.findIndex((h, i) => h !== childHashes[i]);
    comparisons.push({
      name: "separate-process",
      description: "same run in a separate Node process (per-tick SHA-256 of state bytes)",
      ticksCompared: Math.min(refHashes.length, childHashes.length),
      identical: firstDiff === -1 && refHashes.length === childHashes.length,
      firstDivergence: firstDiff === -1 ? null : firstDiff,
      differingFields: firstDiff === -1 ? [] : [{ field: "sha256", reference: refHashes[firstDiff], other: childHashes[firstDiff] }],
    });
  }

  {
    const sim3 = await LocalSimulation.create(init);
    const loop = await sim3.runWorkerLoop(track, encodeRecording(inputs), FRAMES);
    sim3.dispose();
    comparisons.push(compareStreams("game-worker-loop", "the game's own non-realtime stepping loop replaying the inputs as a PolyTrack recording", reference.states, loop.map(withoutCarId)));
  }

  for (const name of EXTRA_TRACKS) {
    const t = await loadCapturedTrack(name);
    const a = await runDirect(init, t, inputs);
    const b = await runDirect(init, t, inputs);
    comparisons.push(compareStreams(`repeat-${name}`, `repeat run on ${t.name}`, a.states, b.states));
  }

  // Checkpoint + respawn scenario: holding throttle on Summer 6 passes checkpoint 1 at ~3.3 s.
  {
    const t = await loadCapturedTrack(CHECKPOINT_TRACK);
    const up = { ...NONE, up: true };
    const cpInputs: PolyTrackControls[] = [
      ...Array<PolyTrackControls>(RESPAWN_AT).fill(up),
      { ...NONE, reset: true },
      ...Array<PolyTrackControls>(CHECKPOINT_FRAMES - RESPAWN_AT - 1).fill(up),
    ];
    const a = await runDirect(init, t, cpInputs);
    const b = await runDirect(init, t, cpInputs);
    comparisons.push(compareStreams(`checkpoint-respawn-${CHECKPOINT_TRACK}`, `repeat run on ${t.name}: throttle through checkpoint 1, reset key at tick ${RESPAWN_AT}, throttle again`, a.states, b.states));
    const sim4 = await LocalSimulation.create(init);
    const loop = await sim4.runWorkerLoop(t, encodeRecording(cpInputs), CHECKPOINT_FRAMES);
    sim4.dispose();
    comparisons.push(compareStreams(`checkpoint-respawn-${CHECKPOINT_TRACK}-worker-loop`, "same scenario through the game's own stepping loop (recording replay)", a.states, loop.map(withoutCarId)));

    const states = a.states.map(decodeState);
    const cpTick = states.findIndex((s) => s.nextCheckpointIndex > 0);
    const before = states[RESPAWN_AT - 1]!;
    const onReset = states[RESPAWN_AT]!;
    const atCp = states[cpTick]!;
    const gap = (p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number }) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
    observations.checkpointRespawn = {
      track: t.name,
      checkpointPassedAtTick: cpTick,
      hasCheckpointToRespawnAtAfterPass: atCp.hasCheckpointToRespawnAt,
      beforeReset: { speedKmh: before.speedKmh, distanceFromCheckpointPass: gap(before.position, atCp.position) },
      resetTick: { speedKmh: onReset.speedKmh, distanceFromCheckpointPass: gap(onReset.position, atCp.position), frames: onReset.frames, nextCheckpointIndex: onReset.nextCheckpointIndex },
    };
  }

  // What the reference run exercised
  const decoded = reference.states.map(decodeState);
  const last = decoded[decoded.length - 1]!;
  observations.referenceRun = {
    ticks: FRAMES,
    ticksPerSecond: reference.ticksPerSecond,
    maxSpeedKmh: Math.max(...decoded.map((s) => s.speedKmh)),
    ticksWithCollisionImpulses: decoded.filter((s) => s.collisionImpulses.length > 0).length,
    ticksWithAWheelAirborne: decoded.filter((s) => s.wheelContact.some((w) => w === null)).length,
    checkpointsPassed: last.nextCheckpointIndex,
    finished: last.finishFrames !== null,
    finalPosition: last.position,
  };
  observations.timeAndRandomnessCallsDuringLoad = loadCounts;
  observations.timeAndRandomnessCallsDuring20kTicks = reference.counts;

  // ── Report ──
  const capabilitiesOk = checks.every((c) => c.ok);
  const deterministic = comparisons.every((c) => c.identical);
  console.log("\nCapabilities");
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
  const rk2 = observations.resetKey as { hasCheckpointToRespawnAt: boolean; before: { distanceFromStart: number }; resetTick: { distanceFromStart: number; speedKmh: number }; tenTicksLater: { distanceFromStart: number } };
  console.log(`  INFO  reset key (no checkpoint, hasCheckpointToRespawnAt=${rk2.hasCheckpointToRespawnAt}): distance from start ${rk2.before.distanceFromStart.toFixed(2)} → ${rk2.resetTick.distanceFromStart.toFixed(2)} on reset tick (speed ${rk2.resetTick.speedKmh.toFixed(2)} km/h) → ${rk2.tenTicksLater.distanceFromStart.toFixed(2)} 10 ticks later`);

  const cr = observations.checkpointRespawn as { track: string; checkpointPassedAtTick: number; hasCheckpointToRespawnAtAfterPass: boolean; beforeReset: { speedKmh: number; distanceFromCheckpointPass: number }; resetTick: { speedKmh: number; distanceFromCheckpointPass: number; nextCheckpointIndex: number } };
  console.log(`  INFO  reset key after checkpoint (${cr.track}): checkpoint 1 passed at tick ${cr.checkpointPassedAtTick} (hasCheckpointToRespawnAt=${cr.hasCheckpointToRespawnAtAfterPass}); on reset tick ${cr.beforeReset.distanceFromCheckpointPass.toFixed(2)} → ${cr.resetTick.distanceFromCheckpointPass.toFixed(2)} from checkpoint pass point, speed ${cr.beforeReset.speedKmh.toFixed(2)} → ${cr.resetTick.speedKmh.toFixed(2)} km/h, nextCheckpointIndex ${cr.resetTick.nextCheckpointIndex}`);

  console.log("\nDeterministic replay (reference: fresh instance, per-tick byte comparison)");
  for (const c of comparisons) {
    const where = c.identical ? "" : ` (first divergence at tick ${c.firstDivergence}; fields: ${c.differingFields.map((f) => f.field).join(", ") || "n/a"})`;
    console.log(`  ${c.identical ? "IDENTICAL" : "DIVERGED "}  ${c.name}: ${c.ticksCompared} ticks${where}`);
    console.log(`             ${c.description}`);
  }

  const run = observations.referenceRun as Record<string, unknown>;
  console.log("\nReference run exercised the physics");
  console.log(`  max speed ${(run.maxSpeedKmh as number).toFixed(1)} km/h · ${String(run.ticksWithCollisionImpulses)} ticks with collisions · ${String(run.ticksWithAWheelAirborne)} ticks with a wheel airborne · checkpoints ${String(run.checkpointsPassed)}`);
  console.log(`  speed: ${String(run.ticksPerSecond)} ticks/s (${(Number(run.ticksPerSecond) / 1000).toFixed(0)}× real time) single-threaded`);
  console.log("\nTime/randomness sources called by worker + physics");
  console.log(`  during load:     ${JSON.stringify(loadCounts)}`);
  console.log(`  during stepping: ${JSON.stringify(reference.counts)}`);

  await mkdir(join(PROJECT_ROOT, "data", "verification"), { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify({ version: POLYTRACK_LOCAL_VERSION, track: TRACK, frames: FRAMES, seed: SEED, checks, comparisons, observations, capabilitiesOk, deterministic }, null, 2));
  console.log(`\nReport: ${REPORT_PATH}`);
  console.log(`RESULT: capabilities ${capabilitiesOk ? "PASS" : "FAIL"} · determinism ${deterministic ? "PASS (all runs byte-identical)" : "FAIL"}`);
  process.exit(capabilitiesOk && deterministic ? 0 : 1);
}

const childIndex = process.argv.indexOf("--child");
(childIndex >= 0 ? childMain(process.argv.slice(childIndex + 1)) : main()).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

/**
 * Local, browser-free PolyTrack 0.6.3 simulation.
 *
 * Setup goes through the game's own worker messages (Init, CreateCar,
 * DeleteCar), so collision data and car placement are marshalled by the
 * original code. Stepping calls the physics export `updateCarModel` directly,
 * exactly as the worker's own loops do, one 1 ms tick per call, with inputs
 * chosen by the caller. That gives closed-loop control, which the stock
 * message protocol cannot provide (docs/POLYTRACK_PROTOCOL.md §7).
 */
import type { PolyTrackControls } from "../PolyTrackInterface.js";
import { PolyTrackMessageType } from "../PolyTrackInterface.js";
import type { CapturedInit, CapturedTrack } from "./capture.js";
import { CAR_STATE_BUFFER_SIZE, decodeCarBuffer, type DecodedCarBuffer } from "./carState.js";
import { WorkerHost, type WorkerHostOptions } from "./WorkerHost.js";

export interface CarStep {
  /** Meaningful raw bytes produced by the physics for this tick (carId + CarState). */
  readonly raw: Uint8Array;
  readonly decoded: DecodedCarBuffer;
}

const UPDATE_ARG_TYPES = ["number", "boolean", "boolean", "boolean", "boolean", "boolean", "number"] as const;

export class LocalSimulation {
  private nextCarId = 0;

  private constructor(
    readonly host: WorkerHost,
    private readonly outPtr: number,
  ) {}

  /** Loads the worker + physics in a fresh isolated context and sends the game's captured Init message. */
  static async create(init: CapturedInit, hostOptions: WorkerHostOptions = {}): Promise<LocalSimulation> {
    const host = await WorkerHost.create(hostOptions);
    host.post({
      messageType: PolyTrackMessageType.Init,
      version: init.version,
      isRealtime: false,
      trackParts: init.trackParts,
      carCollisionShapeVertices: init.carCollisionShapeVertices,
      carMassOffset: init.carMassOffset,
    });
    const ptr = host.physics.ccall("malloc", "number", ["number"], [CAR_STATE_BUFFER_SIZE]);
    if (typeof ptr !== "number" || ptr === 0) throw new Error("Failed to allocate car state buffer");
    return new LocalSimulation(host, ptr);
  }

  /** Places a new car at the track start. With `recording`, the car replays it (worker loop only). */
  createCar(track: CapturedTrack, recording: string | null = null): number {
    const carId = this.nextCarId++;
    this.host.post({
      messageType: PolyTrackMessageType.CreateCar,
      trackData: track.saveString,
      carId,
      carRecording: recording,
      mountainVertices: track.mountainVertices,
      mountainOffset: track.mountainOffset,
    });
    return carId;
  }

  deleteCar(carId: number): void {
    this.host.post({ messageType: PolyTrackMessageType.DeleteCar, carId });
  }

  /** Advances one car by exactly one physics tick (1 ms) with the given inputs and returns the resulting state. */
  step(carId: number, controls: PolyTrackControls): CarStep {
    const physics = this.host.physics;
    physics.ccall("updateCarModel", "void", UPDATE_ARG_TYPES, [
      carId,
      controls.up,
      controls.right,
      controls.down,
      controls.left,
      controls.reset,
      this.outPtr,
    ]);
    const full = physics.HEAPU8.slice(this.outPtr, this.outPtr + CAR_STATE_BUFFER_SIZE);
    const decoded = decodeCarBuffer(full);
    return { raw: full.subarray(0, decoded.byteLength), decoded };
  }

  /** Runs the physics library's built-in determinism self-test via the TestDeterminism message. */
  testDeterminism(): boolean {
    let result: boolean | null = null;
    const off = this.host.onMessage((m) => {
      if (m.messageType === PolyTrackMessageType.DeterminismResult) result = m.isDeterminstic === true;
    });
    this.host.post({ messageType: PolyTrackMessageType.TestDeterminism });
    off();
    if (result === null) throw new Error("No DeterminismResult received");
    return result;
  }

  /**
   * Runs a recording through the worker's OWN non-realtime stepping loop
   * (StartCar with targetSimulationTimeFrames) and returns the per-frame raw states.
   */
  async runWorkerLoop(track: CapturedTrack, recording: string, frames: number): Promise<Uint8Array[]> {
    const carId = this.createCar(track, recording);
    const states: Uint8Array[] = [];
    let done!: () => void;
    const finished = new Promise<void>((resolve) => (done = resolve));
    const off = this.host.onMessage((m) => {
      if (m.messageType !== PolyTrackMessageType.UpdateResult) return;
      for (const buffer of m.carStateBuffers as ArrayBuffer[]) {
        const bytes = new Uint8Array(buffer);
        const decoded = decodeCarBuffer(bytes);
        if (decoded.carId !== carId) continue;
        states.push(bytes.slice(0, decoded.byteLength));
        if (states.length >= frames) done();
      }
    });
    this.host.post({ messageType: PolyTrackMessageType.StartCar, carId, targetSimulationTimeFrames: frames });
    await finished;
    off();
    this.deleteCar(carId);
    return states;
  }

  dispose(): void {
    this.host.dispose();
  }
}

/** LocalPolyTrack: the PolyTrackInterface contract on the real 0.6.3 physics. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LocalPolyTrack } from "../src/polytrack/LocalPolyTrack.js";
import type { PolyTrackCarState } from "../src/polytrack/PolyTrackInterface.js";
import { getGameData, getInit, getTrack, NONE, SKIP_WITHOUT_GAME, UP } from "./helpers.js";

async function connected(trackName: string): Promise<LocalPolyTrack> {
  const p = new LocalPolyTrack({ init: await getInit(), gameData: await getGameData() });
  await p.connect(await getTrack(trackName));
  return p;
}

describe("LocalPolyTrack (PolyTrackInterface on real 0.6.3 physics)", { skip: SKIP_WITHOUT_GAME }, () => {
  test("reset() returns the game's spawn state at the track start", async () => {
    const p = await connected("summer1");
    try {
      const track = await getTrack("summer1");
      const s = await p.reset();
      assert.equal(s.frames, 0);
      assert.equal(s.speedKmh, 0);
      assert.equal(s.hasStarted, false);
      assert.equal(s.nextCheckpointIndex, 0);
      assert.deepEqual(s.position, track.startTransform!.position);
      assert.deepEqual(s.quaternion, track.startTransform!.quaternion);
      assert.equal(p.getState(), s);
      assert.equal(p.isFinished(), false);
    } finally {
      await p.disconnect();
    }
  });

  test("step(n) advances exactly n physics ticks and the first tick starts at the spawn pose", async () => {
    const p = await connected("summer1");
    try {
      const spawn = await p.reset();
      const s1 = await p.step();
      assert.equal(s1.frames, 1);
      assert.equal(s1.hasStarted, true);
      assert.ok(Math.abs(s1.position.x - spawn.position.x) < 1e-3 && Math.abs(s1.position.z - spawn.position.z) < 1e-3);
      const s10 = await p.step(9);
      assert.equal(s10.frames, 10);
      await assert.rejects(p.step(0));
    } finally {
      await p.disconnect();
    }
  });

  // Summer 6 starts with a long straight (Summer 1's opening has an obstacle that slows the car at ~1–2 s).
  test("setControls() inputs reach the physics and are held until changed", async () => {
    const p = await connected("summer6");
    try {
      await p.reset();
      p.setControls(UP);
      const a = await p.step(1000);
      assert.deepEqual(a.controls, UP);
      const b = await p.step(1000);
      assert.ok(b.speedKmh > a.speedKmh && a.speedKmh > 10, `speed ${a.speedKmh} → ${b.speedKmh}`);
      p.setControls({ ...NONE, down: true });
      const c = await p.step(500);
      assert.equal(c.controls.down, true);
      assert.ok(c.speedKmh < b.speedKmh);
    } finally {
      await p.disconnect();
    }
  });

  test("getVelocity() (finite difference) matches the physics speed", async () => {
    const p = await connected("summer1");
    try {
      await p.reset();
      p.setControls(UP);
      for (let i = 0; i < 20; i++) {
        const s = await p.step(100);
        const v = p.getVelocity();
        assert.ok(Math.abs(Math.hypot(v.x, v.y, v.z) * 3.6 - s.speedKmh) < 0.1, `tick ${s.frames}`);
      }
    } finally {
      await p.disconnect();
    }
  });

  test("reset() restarts deterministically", async () => {
    const p = await connected("summer1");
    try {
      const run = async (): Promise<PolyTrackCarState[]> => {
        await p.reset();
        const out: PolyTrackCarState[] = [];
        for (let i = 0; i < 3000; i++) {
          p.setControls({ ...UP, left: i % 700 < 200, right: i % 900 > 750 });
          out.push(await p.step());
        }
        return out;
      };
      assert.deepEqual(await run(), await run());
    } finally {
      await p.disconnect();
    }
  });

  test("reset key respawns at the checkpoint; velocity is zeroed on the teleport tick", async () => {
    const p = await connected("summer6");
    try {
      await p.reset();
      p.setControls(UP);
      const before = await p.step(6000);
      assert.equal(before.nextCheckpointIndex, 1);
      p.setControls({ ...NONE, reset: true });
      const after = await p.step();
      assert.ok(after.speedKmh < 1);
      assert.deepEqual(p.getVelocity(), { x: 0, y: 0, z: 0 });
    } finally {
      await p.disconnect();
    }
  });

  test("hasCrashed() applies each policy rule to the per-tick history", async () => {
    const p = await connected("summer1");
    try {
      const spawn = await p.reset();
      p.setControls(NONE);
      await p.step(500);
      assert.equal(p.hasCrashed({ maxFramesWithoutProgress: 499 }), true);
      assert.equal(p.hasCrashed({ maxFramesWithoutProgress: 500 }), false);
      assert.equal(p.hasCrashed({ minY: spawn.position.y + 1 }), true);
      assert.equal(p.hasCrashed({ minY: spawn.position.y - 1 }), false);
      assert.equal(p.hasCrashed({ maxAirborneFrames: 0, maxUpsideDownFrames: 0 }), false); // resting on 4 wheels, upright
      assert.equal(p.hasCrashed({}), false);

      // Airborne counter agrees with an independent count over a run with jumps/collisions.
      await p.reset();
      let consecutive = 0;
      let maxSeen = 0;
      for (let i = 0; i < 8000; i++) {
        p.setControls({ ...UP, left: i % 1100 < 300, right: i % 1500 > 1200 });
        const s = await p.step();
        consecutive = s.wheelContact.every((w) => w === null) ? consecutive + 1 : 0;
        maxSeen = Math.max(maxSeen, consecutive);
        assert.equal(p.airborneFrames, consecutive);
        assert.equal(p.hasCrashed({ maxAirborneFrames: 50 }), consecutive > 50);
      }
      assert.ok(maxSeen > 0, "run should include airborne ticks");
    } finally {
      await p.disconnect();
    }
  });

  test("using it before connect/reset or after disconnect throws", async () => {
    const p = new LocalPolyTrack({ init: await getInit(), gameData: await getGameData() });
    await assert.rejects(p.reset());
    await p.connect(await getTrack("summer1"));
    await assert.rejects(p.step());
    await p.disconnect();
    await assert.rejects(p.reset());
  });
});

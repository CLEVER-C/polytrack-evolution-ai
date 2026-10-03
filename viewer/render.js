/*
 * Renders replays with PolyTrack 0.6.3's OWN rendering code.
 *
 * render.html loads the unmodified game bundle (/game/main.bundle.js). Before it
 * runs, this script registers with the game's webpack chunk registry, which gives
 * access to the game's modules:
 *
 *   1507  the game's WebGL renderer (scene, shadows, post-processing, cameras)
 *   6762  the track scene (builds the track from the game's part models)
 *   6421  the mountain/terrain generator
 *   641   the car (car.glb model, wheels, suspension, brake lights, chase/cockpit cameras)
 *   9117  the track codec (parses the official .track files)
 *
 * The game boots normally (loading its models, textures and physics worker).
 * Once it is ready, the viewer takes over the game's animation loop: it loads
 * the replay's track into the game's track scene, creates a game car, and on
 * every frame hands it the car state computed by the real physics on the
 * server (ReplayPlayer). The car's look, the track, terrain, lighting and
 * cameras are all the game's own. No geometry is drawn by this file.
 *
 * Nothing in the game files is changed; methods are wrapped at runtime.
 */
(() => {
  "use strict";

  const MODULES = { renderer: 1507, trackScene: 6762, mountains: 6421, car: 641, trackCodec: 9117 };

  let req = null;
  let renderer = null;
  let mountains = null;
  let trackScene = null;
  let takenOver = false;
  let lastTime = null;

  let car = null;
  let trackSha = null;
  let cameraMode = "orbit";
  let pending = null; // { state, reset }
  let playing = false;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Polled with a timer, not from the animation loop, which browsers pause in hidden tabs.
  const readyPoll = setInterval(() => {
    try {
      if (!gameIsReady()) return;
      resolveReady();
    } catch (err) {
      rejectReady(err);
    }
    clearInterval(readyPoll);
  }, 200);
  setTimeout(() => {
    clearInterval(readyPoll);
    rejectReady(new Error("PolyTrack did not finish loading within 120 s"));
  }, 120_000);

  self.webpackChunk = self.webpackChunk || [];
  self.webpackChunk.push([["__evolution_viewer"], {}, (r) => {
    req = r;
    try {
      install();
    } catch (err) {
      rejectReady(err);
    }
  }]);

  function exportWith(id, member) {
    const mod = req(id);
    const found = Object.values(mod).find((v) => v != null && (typeof v[member] === "function" || (v.prototype && typeof v.prototype[member] === "function")));
    if (found === undefined) throw new Error(`PolyTrack module ${id} has no "${member}" (unexpected game build)`);
    return found;
  }

  function install() {
    const Renderer = exportWith(MODULES.renderer, "setAnimationLoop");
    const Mountains = exportWith(MODULES.mountains, "generateMountains");

    // The game calls setAnimationLoop once at the end of boot; route its frames through us.
    const setAnimationLoop = Renderer.prototype.setAnimationLoop;
    Renderer.prototype.setAnimationLoop = function (gameFrame) {
      renderer = this;
      return setAnimationLoop.call(this, (time) => frame(time, gameFrame));
    };
    // The main menu updates the mountains with the track scene every frame: that hands us both instances.
    const updateMountains = Mountains.prototype.update;
    Mountains.prototype.update = function (scene) {
      mountains = this;
      trackScene = scene;
      return updateMountains.call(this, scene);
    };
  }

  function gameIsReady() {
    if (renderer === null || mountains === null || trackScene === null) return false;
    const Car = exportWith(MODULES.car, "setCarState");
    return Car.models != null; // car.glb loaded
  }

  function frame(time, gameFrame) {
    const dt = lastTime === null ? 0 : Math.max(time - lastTime, 0) / 1000;
    lastTime = time;
    if (!takenOver) {
      gameFrame(time);
      return;
    }
    if (car !== null) {
      if (pending !== null) {
        car.setCarState(pending.state, pending.reset);
        pending = null;
      }
      const step = playing ? dt : 0;
      car.update(step);
      car.updateCameras(step);
    }
    mountains.update(trackScene);
    renderer.update(trackScene.sunDirection);
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function applyCamera() {
    if (car !== null) renderer.setCamera(cameraMode === "cockpit" ? car.cameraCockpit : car.cameraOrbit);
  }

  window.polytrackRenderer = {
    /** Resolves when the game has booted and its resources are loaded. */
    whenReady: () => ready,

    /**
     * Loads an official track file into the game's track scene and places a new
     * game car at its start. The track is parsed by the game's own codec and must
     * hash to `expectedSha256` (the track the replay was recorded on).
     */
    async loadTrack(url, expectedSha256) {
      await ready;
      if (trackSha === expectedSha256 && car !== null) return;
      const text = await fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Track file ${url}: HTTP ${r.status}`);
        return r.text();
      });
      const parsed = exportWith(MODULES.trackCodec, "fromExportString").fromExportString(text);
      if (parsed == null) throw new Error(`PolyTrack could not parse ${url}`);
      const trackData = parsed.trackData;
      const sha = await sha256Hex(trackData.toSaveString());
      if (sha !== expectedSha256) throw new Error(`Track ${url} does not match the replay's track (sha256 ${sha.slice(0, 12)}… ≠ ${expectedSha256.slice(0, 12)}…)`);

      takenOver = true;
      if (car !== null) car.dispose();
      car = null;
      trackScene.loadTrackData(trackData);
      trackScene.refreshMeshes();
      mountains.generateMountains(trackScene.getBounds());
      const start = trackScene.getStartTransform();
      if (start == null) throw new Error("Track has no start");
      const Car = exportWith(MODULES.car, "setCarState");
      // (simulation, startTransform, recording, controls, renderer, audio, mountains, track, trackData, settings, onState):
      // no simulation client, so the car is driven only by setCarState with states from the real physics.
      car = new Car(null, start, null, null, renderer, null, mountains, trackScene, trackData, null, null);
      trackSha = expectedSha256;
      applyCamera();
      return { name: parsed.trackMetadata?.name ?? null };
    },

    /** Shows a physics state (the game's CarState format). `reset` = the car jumped (load/restart). */
    setCarState(state, reset, isPlaying) {
      playing = isPlaying;
      pending = { state, reset: reset || (pending?.reset ?? false) };
    },

    setCameraMode(mode) {
      cameraMode = mode === "cockpit" ? "cockpit" : "orbit";
      applyCamera();
    },
  };
})();

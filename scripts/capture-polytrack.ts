/**
 * One-time "bake" step: runs the unmodified local PolyTrack 0.6.3 build in
 * headless Edge/Chrome and records the inputs the physics worker needs.
 *
 * - Init: the game's real Init message, intercepted by wrapping `Worker` before
 *   the page loads (track-part collision geometry, car collision shape, mass offset).
 * - Per track: the CreateCar inputs (save string, mountain vertices/offset),
 *   computed by calling the game's own webpack modules (9117 track parser,
 *   6421 mountain generator).
 *
 * All network requests except to the local server are blocked, so nothing is
 * sent to Kodub's servers. Output goes to vendor/ (gitignored).
 *
 *   node dist/scripts/capture-polytrack.js [--channel msedge|chrome]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";
import {
  CAPTURE_DIR,
  GAME_DATA_CAPTURE_PATH,
  GAME_DIR,
  INIT_CAPTURE_PATH,
  MANIFEST_PATH,
  POLYTRACK_LOCAL_VERSION,
  TRACKS_CAPTURE_DIR,
  type Manifest,
} from "../src/polytrack/local/paths.js";
import { serveDirectory } from "../src/polytrack/local/staticServer.js";

const channelArg = process.argv.indexOf("--channel");
const channel = (channelArg >= 0 ? process.argv[channelArg + 1] : process.env.POLYTRACK_BROWSER_CHANNEL) ?? "msedge";

/** Shared browser-side encoder: typed arrays → {__typed, b64}. */
const ENCODER = String.raw`
  function __ptEncode(v) {
    if (ArrayBuffer.isView(v)) {
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { __typed: v.constructor.name, b64: btoa(s) };
    }
    if (Array.isArray(v)) return v.map(__ptEncode);
    if (v !== null && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = __ptEncode(v[k]);
      return o;
    }
    return v;
  }
`;

/** Installed before any page script: records every Init message posted to a simulation worker. */
const WORKER_HOOK = String.raw`(() => {
  ${ENCODER}
  window.__ptEncode = __ptEncode;
  window.__ptInits = [];
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(url, options) { super(url, options); this.__ptUrl = String(url); }
    postMessage(message, ...rest) {
      if (this.__ptUrl.includes("simulation_worker") && message && message.messageType === 0) {
        window.__ptInits.push(JSON.stringify(__ptEncode(message)));
      }
      return super.postMessage(message, ...rest);
    }
  };
})();`;

/** Runs in the page: computes CreateCar inputs for each track with the game's own modules. */
const TRACK_EXTRACTOR = String.raw`async (files) => {
  let req;
  self.webpackChunk.push([["__polytrack_capture"], {}, (r) => { req = r; }]);
  if (typeof req !== "function") throw new Error("webpack runtime not reachable");
  const pick = (id, prop) => {
    const mod = req(id);
    const found = Object.values(mod).find((v) => v && typeof v[prop] === "function");
    if (!found) throw new Error("module " + id + " has no " + prop);
    return found;
  };
  const TrackCodec = pick(9117, "fromExportString");
  const Mountains = pick(6421, "createMountainVertices");
  const Registry = req(2600);
  const out = [];
  for (const file of files) {
    const code = await fetch(file).then((r) => r.text());
    const parsed = TrackCodec.fromExportString(code);
    if (parsed == null) throw new Error("fromExportString failed for " + file);
    const td = parsed.trackData;
    const m = Mountains.createMountainVertices(td.getBounds());
    const st = td.getStartTransform();
    const parts = [];
    td.forEachPart((x, y, z, id, rotation, rotationAxis, color, checkpointOrder, startOrder) => {
      const tiles = [];
      Registry.Hw(id).tiles.rotated(rotation, rotationAxis).forEach((tx, ty, tz) => tiles.push([tx, ty, tz]));
      parts.push({ id, x, y, z, rotation, rotationAxis, color, checkpointOrder: checkpointOrder ?? null, startOrder: startOrder ?? null, tiles });
    });
    out.push(JSON.stringify(window.__ptEncode({
      file,
      name: parsed.trackMetadata.name,
      author: parsed.trackMetadata.author,
      saveString: td.toSaveString(),
      // Same conversion the game applies before CreateCar during a race (getMountainVertices).
      mountainVertices: new Float32Array(m.vertices),
      mountainOffset: { x: m.offset.x, y: m.offset.y, z: m.offset.z },
      parts,
      startTransform: st == null ? null : {
        position: { x: st.position.x, y: st.position.y, z: st.position.z },
        quaternion: { x: st.quaternion.x, y: st.quaternion.y, z: st.quaternion.z, w: st.quaternion.w },
      },
    })));
  }
  return out;
}`;

/**
 * Runs in the page: static game data needed to place track parts in world space,
 * read from the game's own modules (6762 partSize, 5494 rotation table,
 * 2600 part registry, 494 part names, 3080 detector types, 7781 rotation axes,
 * 641 car constants).
 */
const GAME_DATA_EXTRACTOR = String.raw`() => {
  let req;
  self.webpackChunk.push([["__polytrack_capture_data"], {}, (r) => { req = r; }]);
  const enumNames = (id) => {
    const e = Object.values(req(id))[0];
    return Object.fromEntries(Object.entries(e).filter(([k]) => !/^\d+$/.test(k)));
  };
  const Rotations = req(5494);
  const rotationQuaternions = [];
  for (let axis = 0; axis < 6; axis++) {
    const row = [];
    for (let rotation = 0; rotation < 4; rotation++) {
      const q = Rotations.hT(rotation, axis);
      row.push({ x: q.x, y: q.y, z: q.z, w: q.w });
    }
    rotationQuaternions.push(row);
  }
  const Registry = req(2600);
  const partNames = enumNames(494);
  const nameById = Object.fromEntries(Object.entries(partNames).map(([k, v]) => [v, k]));
  const Car = req(641).A;
  const v3 = (v) => [v.x, v.y, v.z];
  return JSON.stringify({
    partSize: req(6762).A.partSize,
    car: {
      massOffset: Car.massOffset,
      suspensionResetLengthFront: Car.suspensionResetLengthFront,
      suspensionResetLengthRear: Car.suspensionResetLengthRear,
      detectorBoxCenter: v3(Car.detectorBoxCenter),
      detectorBoxSize: v3(Car.detectorBoxSize),
    },
    rotationAxes: enumNames(7781),
    detectorTypes: enumNames(3080),
    rotationQuaternions,
    checkpointPartIds: Registry.bK,
    startPartIds: Registry.l1,
    parts: Registry.yD.map((p) => ({
      id: p.id,
      name: nameById[p.id] ?? null,
      category: p.category,
      models: p.models,
      detector: p.detector == null ? null : { type: p.detector.type, center: [...p.detector.center], size: [...p.detector.size] },
      startOffset: p.startOffset == null ? null : [p.startOffset.x, p.startOffset.y, p.startOffset.z],
    })),
  });
}`;

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Manifest;
  const trackFiles = manifest.files.map((f) => f.path).filter((p) => p.endsWith(".track"));

  const server = await serveDirectory(GAME_DIR);
  console.log(`Serving ${GAME_DIR} at ${server.origin}`);
  const browser = await chromium.launch({
    channel,
    headless: true,
    args: ["--mute-audio", "--enable-unsafe-swiftshader", "--use-angle=swiftshader"],
  });
  try {
    const context = await browser.newContext();
    const blocked = new Set<string>();
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url.startsWith(server.origin) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
      blocked.add(new URL(url).origin);
      return route.abort();
    });
    await context.addInitScript({ content: WORKER_HOOK });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`${server.origin}/index.html`);
    console.log("Waiting for the game to post Init to its simulation workers...");
    await page.waitForFunction("window.__ptInits.length >= 2", undefined, { timeout: 120_000 });

    const inits = (await page.evaluate("window.__ptInits")) as string[];
    const parsed = inits.map((s) => JSON.parse(s) as Record<string, unknown>);
    const strip = (m: Record<string, unknown>): string => JSON.stringify({ ...m, isRealtime: undefined });
    if (new Set(parsed.map(strip)).size !== 1) throw new Error("The two simulation workers received different Init data");
    const init = parsed[0]!;
    if (init.version !== POLYTRACK_LOCAL_VERSION) throw new Error(`Unexpected game version ${String(init.version)}`);
    const { messageType: _t, isRealtime: _r, ...initPayload } = init;

    console.log(`Computing CreateCar inputs for ${trackFiles.length} tracks with the game's own modules...`);
    const tracks = (await page.evaluate(`(${TRACK_EXTRACTOR})(${JSON.stringify(trackFiles)})`)) as string[];
    const gameData = (await page.evaluate(`(${GAME_DATA_EXTRACTOR})()`)) as string;

    await mkdir(TRACKS_CAPTURE_DIR, { recursive: true });
    await writeFile(INIT_CAPTURE_PATH, JSON.stringify(initPayload));
    await writeFile(GAME_DATA_CAPTURE_PATH, gameData);
    for (const json of tracks) {
      const { file } = JSON.parse(json) as { file: string };
      const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.track$/, "");
      await writeFile(join(TRACKS_CAPTURE_DIR, `${stem}.json`), json);
    }

    const parts = (initPayload.trackParts as unknown[]).length;
    console.log(`Init captured: ${parts} track part configurations -> ${INIT_CAPTURE_PATH}`);
    console.log(`Tracks captured: ${tracks.length} -> ${TRACKS_CAPTURE_DIR}`);
    if (blocked.size > 0) console.log(`Blocked external requests to: ${[...blocked].join(", ")}`);
    if (pageErrors.length > 0) console.log(`Page errors (non-fatal for capture):\n  ${pageErrors.join("\n  ")}`);
    console.log(`OK: capture written to ${CAPTURE_DIR}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});

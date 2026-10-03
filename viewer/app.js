// Viewer UI. Physics runs on the server (ReplayPlayer on the real PolyTrack physics);
// rendering is done by PolyTrack's own code inside the render.html iframe. This file
// only wires the two together and draws the controls, generation list, dashboard and graph.

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const state = {
  run: null,
  generations: [],
  loaded: null, // LoadedReplayInfo from the server
  frame: null,
  lastResetSeq: -1,
  renderer: null,
  rendererPromise: null, // resolves to the renderer once PolyTrack has booted
  loading: false, // a generation is being loaded; playback buttons wait for it
  watch: false,
  watchTimer: null,
  renderedRows: "",
};

// ---------- formatting ----------
const fmtFitness = (v) => (v == null ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
const fmtTime = (ticks) => (ticks == null ? "—" : `${(ticks / 1000).toFixed(3)}s`);
const fmtDuration = (ms) => {
  const t = Math.round(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
};
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- server calls ----------
async function api(path, body) {
  const res = await fetch(path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}
const command = (name, body = {}) => api(`/api/player/${name}`, body).catch(showError);

let errorTimer = null;
function showError(err) {
  const el = $("error");
  el.textContent = err instanceof Error ? err.message : String(err);
  el.classList.remove("hidden");
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => el.classList.add("hidden"), 10_000);
  console.error(err);
}

// ---------- renderer (PolyTrack inside the iframe) ----------
function rendererReady() {
  const frame = $("renderer");
  return new Promise((resolve) => {
    const attach = () => {
      const api = frame.contentWindow?.polytrackRenderer;
      if (api === undefined) return setTimeout(attach, 100);
      api.whenReady().then(() => resolve(api), (err) => {
        $("screen-message").textContent = `PolyTrack failed to load: ${err.message}`;
      });
    };
    attach();
  });
}

// ---------- runs & generations ----------
async function loadRuns() {
  const { runs } = await api("/api/runs");
  const select = $("run-select");
  select.innerHTML = runs.map((r) => `<option value="${escape(r.id)}">${escape(r.id)} (${r.generations} gen)</option>`).join("");
  if (runs.length === 0) {
    $("screen-message").textContent = "No training runs found in data/runs/. Start one with: npm run train";
    return;
  }
  const wanted = params.get("run");
  state.run = runs.some((r) => r.id === wanted) ? wanted : runs[0].id;
  select.value = state.run;
}

async function refreshGenerations() {
  if (state.run === null) return;
  const { generations } = await api(`/api/generations?run=${encodeURIComponent(state.run)}`);
  state.generations = generations;
  const option = [...$("run-select").options].find((o) => o.value === state.run);
  if (option) option.textContent = `${state.run} (${generations.length} gen)`;
  renderGenerationRows();
  drawGraph();
}

function renderGenerationRows() {
  const selected = state.loaded?.run === state.run ? state.loaded.generation : null;
  const key = `${state.run}|${state.generations.length}|${selected}`;
  if (key === state.renderedRows) return;
  state.renderedRows = key;
  $("generation-count").textContent = `${state.generations.length}`;
  $("generation-rows").innerHTML = state.generations
    .map((g) => {
      const cls = [g.generation === selected ? "selected" : "", g.hasReplay ? "" : "no-replay"].join(" ");
      return `<tr data-generation="${g.generation}" class="${cls}" title="Best: ${escape(g.bestIndividualId)} · ${g.finishedCount}/${g.populationSize} finished">
        <td>${g.generation}</td><td>${fmtFitness(g.bestFitness)}</td><td>${fmtFitness(g.averageFitness)}</td>
        <td class="${g.bestTime != null ? "finished" : ""}">${fmtTime(g.bestTime)}</td><td>${g.checkpointsReached}/${g.checkpointCount}</td></tr>`;
    })
    .join("");
  $("generation-rows").querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
}

async function loadGeneration(generation, { play = false } = {}) {
  state.loading = true;
  updateButtons();
  try {
    const info = await api("/api/player/load", { run: state.run, generation });
    state.loaded = info.loaded;
    renderLoaded();
    $("screen-message").textContent = `Loading ${info.loaded.track.name}…`;
    $("screen-message").classList.remove("hidden");
    const renderer = await state.rendererPromise; // a click can come before PolyTrack has booted
    await renderer.loadTrack(info.loaded.track.url, info.loaded.track.sha256);
    $("screen-message").classList.add("hidden");
    $("hud").classList.remove("hidden");
    // Playback may have moved on while the track was loading: show the player's current frame on the new car.
    state.lastResetSeq = -1;
    const current = (await api("/api/player")).frame;
    state.loading = false;
    onFrame(current);
    if (play) await command("play");
  } catch (err) {
    showError(err);
  } finally {
    state.loading = false;
    updateButtons();
  }
}

function updateButtons() {
  const idle = state.loaded == null || state.loading;
  const playing = state.frame?.playing === true;
  $("btn-play").disabled = idle || playing;
  $("btn-pause").disabled = idle || !playing;
  $("btn-restart").disabled = idle;
  $("btn-step").disabled = idle;
}

function renderLoaded() {
  const l = state.loaded;
  const s = l?.summary;
  $("stat-generation").textContent = l ? String(l.generation) : "—";
  $("stat-best").textContent = s ? fmtFitness(s.bestFitness) : "—";
  $("stat-average").textContent = s ? fmtFitness(s.averageFitness) : "—";
  $("stat-time").textContent = s ? fmtTime(s.bestTime) : "—";
  $("stat-checkpoints").textContent = s ? `${s.checkpointsReached} / ${s.checkpointCount}` : "—";
  updateButtons();
  renderGenerationRows();
  drawGraph();
}

// ---------- playback frames (Server-Sent Events) ----------
function onFrame(frame) {
  if (frame == null) return;
  state.frame = frame;
  const reset = frame.resetSeq !== state.lastResetSeq;
  state.lastResetSeq = frame.resetSeq;
  state.renderer?.setCarState(frame.state, reset, frame.playing);

  const pct = frame.totalTicks > 0 ? (100 * frame.tick) / frame.totalTicks : 0;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-text").textContent = `${Math.floor(pct)}%  ·  ${(frame.tick / 1000).toFixed(2)} / ${(frame.totalTicks / 1000).toFixed(2)} s`;
  $("hud-speed").textContent = Math.round(frame.state.speedKmh);
  $("hud-time").textContent = (frame.tick / 1000).toFixed(3);
  updateButtons();
  for (const b of $("speed-buttons").children) b.classList.toggle("active", Number(b.dataset.speed) === frame.speed);

  if (frame.finished && state.watch && frame.run === state.run && frame.generation === state.loaded?.generation) scheduleNextGeneration();
}

function connectStream() {
  const source = new EventSource("/api/player/stream");
  source.onmessage = (e) => onFrame(JSON.parse(e.data));
  source.onerror = () => {
    source.close();
    setTimeout(connectStream, 2000);
  };
}

// ---------- WATCH EVOLUTION ----------
function setWatch(on) {
  state.watch = on;
  $("btn-watch").setAttribute("aria-pressed", String(on));
  clearTimeout(state.watchTimer);
  state.watchTimer = null;
  $("watch-status").textContent = "";
  if (!on) return;
  const first = state.generations.find((g) => g.hasReplay);
  if (first === undefined) {
    // Training may not have finished its first generation yet: keep checking.
    $("watch-status").textContent = "Waiting for the first generation…";
    state.watchTimer = setTimeout(async () => {
      await refreshGenerations().catch(showError);
      if (state.watch) setWatch(true);
    }, 3000);
    return;
  }
  void loadGeneration(first.generation, { play: true });
}

function scheduleNextGeneration() {
  if (state.watchTimer !== null) return;
  const current = state.loaded.generation;
  const next = state.generations.find((g) => g.generation > current && g.hasReplay);
  if (next === undefined) {
    // Reached the newest generation: wait for training to save another one.
    $("watch-status").textContent = `Watched up to generation ${current}. Waiting for generation ${current + 1}…`;
    state.watchTimer = setTimeout(async () => {
      state.watchTimer = null;
      await refreshGenerations().catch(showError);
      if (state.watch && state.frame?.finished) scheduleNextGeneration();
    }, 3000);
    return;
  }
  const pause = Math.max(0, Number($("watch-pause").value) || 0);
  $("watch-status").textContent = `Next: generation ${next.generation} in ${pause}s`;
  state.watchTimer = setTimeout(() => {
    state.watchTimer = null;
    if (!state.watch) return;
    $("watch-status").textContent = `Watching generation ${next.generation}`;
    void loadGeneration(next.generation, { play: true });
  }, pause * 1000);
}

// ---------- live training dashboard ----------
async function refreshStatus() {
  if (state.run === null) return;
  const { status } = await api(`/api/status?run=${encodeURIComponent(state.run)}`);
  const badge = $("live-phase");
  if (status === null) {
    badge.textContent = "offline";
    badge.className = "badge";
    $("live-note").textContent = "No live status for this run. It appears once training runs with this build (npm run train).";
    for (const dd of $("dashboard").querySelectorAll("dd")) dd.textContent = "—";
    return;
  }
  const ageS = (Date.now() - Date.parse(status.updatedAt)) / 1000;
  const stale = status.phase === "evaluating" && ageS > 60;
  badge.textContent = stale ? "stale" : status.phase;
  badge.className = `badge ${stale ? "" : status.phase}`;
  const sameGen = status.lastGeneration?.generation === status.generation;
  $("live-generation").textContent = status.phase === "evaluating" ? `${status.generation} (${status.evaluated}/${status.populationSize})` : String(status.generation);
  $("live-population").textContent = String(status.populationSize);
  $("live-generation-best").textContent = fmtFitness(sameGen ? status.lastGeneration.bestFitness : status.generationBestFitness);
  $("live-alltime-best").textContent = fmtFitness(status.allTimeBestFitness);
  $("live-average").textContent = fmtFitness(sameGen ? status.lastGeneration.averageFitness : status.averageFitness);
  $("live-completed").textContent = `${status.completed} / ${status.populationSize}`;
  $("live-best-time").textContent = fmtTime(status.bestTime);
  $("live-mutation").textContent = `${status.mutationRate} (σ ${status.mutationStrength})`;
  $("live-speed").textContent = `${status.ticksPerSecond.toLocaleString("en-US")} ticks/s`;
  $("live-agents").textContent = status.agentsPerSecond == null ? "—" : String(status.agentsPerSecond);
  $("live-workers").textContent = status.workers == null ? "—" : status.workers === 0 ? "main thread" : String(status.workers);
  $("live-elapsed").textContent = status.elapsedMs == null ? "—" : fmtDuration(status.elapsedMs);
  $("live-note").textContent = `Updated ${ageS < 2 ? "just now" : `${Math.round(ageS)} s ago`}${stale ? " — training may have stopped" : ""}.`;
  // New generations appear in the list as soon as training finishes them.
  if (status.lastGeneration && status.lastGeneration.generation >= state.generations.length) void refreshGenerations().catch(showError);
}

// ---------- fitness graph (display only) ----------
function drawGraph() {
  const canvas = $("fitness-graph");
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight || 220;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const gens = state.generations;
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = color("--muted");
  if (gens.length === 0) {
    ctx.fillText("No generations yet", 10, 20);
    return;
  }
  const pad = { left: 46, right: 8, top: 8, bottom: 20 };
  const values = gens.flatMap((g) => [g.bestFitness, g.averageFitness]);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) (hi += 1), (lo -= 1);
  const margin = (hi - lo) * 0.05;
  lo -= margin;
  hi += margin;
  const g0 = gens[0].generation;
  const g1 = Math.max(gens[gens.length - 1].generation, g0 + 1);
  const x = (g) => pad.left + ((g - g0) / (g1 - g0)) * (width - pad.left - pad.right);
  const y = (v) => pad.top + (1 - (v - lo) / (hi - lo)) * (height - pad.top - pad.bottom);
  graphGeometry = { x, g0, g1, pad, width };

  ctx.strokeStyle = color("--line");
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y(v));
    ctx.lineTo(width - pad.right, y(v));
    ctx.stroke();
    ctx.fillText(Math.round(v).toLocaleString("en-US"), pad.left - 4, y(v) + 4);
  }
  ctx.textAlign = "center";
  for (const g of [g0, Math.round((g0 + g1) / 2), g1]) ctx.fillText(String(g), x(g), height - 5);

  const line = (key, stroke) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2;
    ctx.beginPath();
    gens.forEach((g, i) => (i === 0 ? ctx.moveTo(x(g.generation), y(g[key])) : ctx.lineTo(x(g.generation), y(g[key]))));
    ctx.stroke();
  };
  line("averageFitness", color("--avg"));
  line("bestFitness", color("--best"));

  if (state.loaded?.run === state.run) {
    ctx.strokeStyle = color("--text");
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x(state.loaded.generation), pad.top);
    ctx.lineTo(x(state.loaded.generation), height - pad.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
let graphGeometry = null;

function onGraphClick(e) {
  if (graphGeometry === null || state.generations.length === 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const { g0, g1, pad, width } = graphGeometry;
  const g = g0 + ((e.clientX - rect.left - pad.left) / (width - pad.left - pad.right)) * (g1 - g0);
  const nearest = state.generations.filter((r) => r.hasReplay).reduce((best, r) => (best === null || Math.abs(r.generation - g) < Math.abs(best.generation - g) ? r : best), null);
  if (nearest !== null) void loadGeneration(nearest.generation);
}

// ---------- wiring ----------
function wire() {
  $("speed-buttons").innerHTML = SPEEDS.map((s) => `<button data-speed="${s}">${s}x</button>`).join("");
  $("speed-buttons").addEventListener("click", (e) => {
    const speed = e.target.closest("button")?.dataset.speed;
    if (speed !== undefined) void command("speed", { speed: Number(speed) });
  });
  $("btn-play").addEventListener("click", () => void command("play"));
  $("btn-pause").addEventListener("click", () => void command("pause"));
  $("btn-restart").addEventListener("click", () => void command("restart"));
  $("btn-step").addEventListener("click", () => void command("step", { ticks: state.loaded?.ticksPerStep ?? 10 }));
  $("btn-watch").addEventListener("click", () => setWatch(!state.watch));
  $("camera-select").addEventListener("change", (e) => state.renderer?.setCameraMode(e.target.value));
  $("generation-rows").addEventListener("click", (e) => {
    const row = e.target.closest("tr");
    if (row === null || row.classList.contains("no-replay")) return;
    void loadGeneration(Number(row.dataset.generation));
  });
  $("run-select").addEventListener("change", async (e) => {
    setWatch(false);
    state.run = e.target.value;
    state.renderedRows = "";
    await refreshGenerations().catch(showError);
    await refreshStatus().catch(showError);
  });
  $("fitness-graph").addEventListener("click", onGraphClick);
  window.addEventListener("resize", drawGraph);
  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || state.loaded == null || state.loading) return;
    if (e.code === "Space") {
      e.preventDefault();
      void command(state.frame?.playing ? "pause" : "play");
    } else if (e.code === "KeyR") void command("restart");
    else if (e.code === "Period") void command("step", { ticks: state.loaded.ticksPerStep });
  });
  if (params.get("pause") !== null) $("watch-pause").value = params.get("pause");
}

async function main() {
  state.rendererPromise = rendererReady().then((r) => (state.renderer = r));
  wire();
  await loadRuns().catch(showError);
  await refreshGenerations().catch(showError);
  await refreshStatus().catch(showError);
  setInterval(() => refreshStatus().catch(() => undefined), 1000);
  setInterval(() => refreshGenerations().catch(() => undefined), 5000);

  await state.rendererPromise;
  if (state.loaded === null && state.generations.length > 0) $("screen-message").textContent = "Select a generation, or press WATCH EVOLUTION.";
  connectStream();

  // Re-attach to whatever the server's player already has loaded (e.g. after a page reload).
  const current = await api("/api/player").catch(() => null);
  if (params.get("watch") === "1") setWatch(true);
  else if (state.loaded === null && current?.loaded && current.loaded.run === state.run) {
    state.loaded = current.loaded;
    renderLoaded();
    await state.renderer.loadTrack(current.loaded.track.url, current.loaded.track.sha256).catch(showError);
    $("screen-message").classList.add("hidden");
    $("hud").classList.remove("hidden");
    state.lastResetSeq = -1;
    onFrame(current.frame);
  }
}

main();

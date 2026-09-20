const tool = document.getElementById("tool");
const foot = document.getElementById("foot");
const tipDock = document.getElementById("tip-dock");
const panels = {
  monitor: document.getElementById("panel-monitor"),
  control: document.getElementById("panel-control"),
  advanced: document.getElementById("panel-advanced"),
  connection: document.getElementById("panel-connection"),
};

let config = null;
let pollTimer = null;
let busy = false;
let tipHideTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(json?.error || res.statusText || "request failed");
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

function setMode(tab) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add("active");
  Object.values(panels).forEach((p) => p.classList.remove("active"));
  tool.classList.toggle("mode-monitor", tab === "monitor");
  panels[tab]?.classList.add("active");
  const label = tab[0].toUpperCase() + tab.slice(1);
  foot.textContent = `LMS Buddy · ${label}`;
  hideTip();
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => setMode(t.dataset.tab));
});

document.querySelectorAll(".toggle").forEach((el) => {
  el.addEventListener("click", () => {
    el.classList.toggle("on");
    el.setAttribute("aria-checked", el.classList.contains("on"));
    syncAdvancedFromControl();
  });
});

// In-panel tip dock (never clips outside the window)
function showTip(text) {
  clearTimeout(tipHideTimer);
  tipDock.hidden = false;
  tipDock.textContent = text;
}
function hideTip() {
  tipHideTimer = setTimeout(() => {
    tipDock.hidden = true;
    tipDock.textContent = "";
  }, 120);
}
document.querySelectorAll(".help").forEach((btn) => {
  const tip = btn.getAttribute("data-tip") || "";
  btn.addEventListener("mouseenter", () => showTip(tip));
  btn.addEventListener("mouseleave", hideTip);
  btn.addEventListener("focus", () => showTip(tip));
  btn.addEventListener("blur", hideTip);
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    showTip(tip);
  });
});

function hostLabel(cfg) {
  const host = cfg?.host || "—";
  const short = host.includes(".") ? host.split(".").slice(-2).join(".") : host;
  document.getElementById("host-label").innerHTML =
    `<b>${escapeHtml(short)}</b> · :${cfg?.port ?? "—"}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setStatus(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function readControl() {
  return {
    modelId: document.getElementById("model").value,
    context: Number(document.getElementById("ctx").value),
    gpu: document.getElementById("gpu").value,
    parallel: Number(document.getElementById("parallel").value) || 1,
  };
}

function readSettings() {
  const effort = document.getElementById("reasoning").value || "low";
  const base = {
    pleCpu: document.getElementById("tog-ple").classList.contains("on"),
    lazyMode: document.getElementById("lazy").value,
    loadMode: document.getElementById("loadmode").value,
    nCpuMoe: Number(document.getElementById("ncpu").value) || 0,
    gpuLayers: document.getElementById("ngl").value || "all",
    kvQuant: document.getElementById("kvquant").value,
    mmproj: document.getElementById("tog-mmproj").classList.contains("on"),
    reasoningEffort: effort,
    thinking: effort !== "off",
  };
  const extra = parseAdvancedExtra();
  return { ...base, ...extra, ...pickKnown(extra) };
}

function pickKnown(obj) {
  // Prefer GUI fields for known keys; extras keep unknown keys via spread order in readSettings
  return {};
}

function parseAdvancedExtra() {
  const raw = document.getElementById("advanced-raw").value.trim();
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object" && !Array.isArray(j)) {
      // If full document with settings key, use that; else whole object is settings-ish
      if (j.settings && typeof j.settings === "object") return { ...j.settings, _advancedMeta: omit(j, ["settings"]) };
      return j;
    }
  } catch {
    return { _advancedRawInvalid: true, _advancedRaw: raw };
  }
  return {};
}

function omit(obj, keys) {
  const o = { ...obj };
  for (const k of keys) delete o[k];
  return o;
}

function buildAdvancedDocument() {
  const effort = document.getElementById("reasoning").value || "low";
  return {
    control: readControl(),
    settings: {
      pleCpu: document.getElementById("tog-ple").classList.contains("on"),
      lazyMode: document.getElementById("lazy").value,
      loadMode: document.getElementById("loadmode").value,
      nCpuMoe: Number(document.getElementById("ncpu").value) || 0,
      gpuLayers: document.getElementById("ngl").value || "all",
      kvQuant: document.getElementById("kvquant").value,
      mmproj: document.getElementById("tog-mmproj").classList.contains("on"),
      reasoningEffort: effort,
      thinking: effort !== "off",
    },
    // Free-form extras for wrappers / notes — edit below or add keys
    extras: config?.advanced?.extras || {
      overrideTensor: "per_layer_token_embd=CPU",
      notes: "Add any unsupported flags here. Saved to ~/.lms-buddy/<model>.json",
    },
  };
}

function syncAdvancedFromControl() {
  const ta = document.getElementById("advanced-raw");
  // Don't clobber if user is mid-edit with invalid JSON unless forced
  if (document.activeElement === ta) return;
  try {
    const cur = ta.value.trim() ? JSON.parse(ta.value) : null;
    const doc = buildAdvancedDocument();
    if (cur?.extras) doc.extras = cur.extras;
    if (cur && typeof cur === "object") {
      // Preserve unknown top-level keys
      for (const [k, v] of Object.entries(cur)) {
        if (!["control", "settings", "extras"].includes(k)) doc[k] = v;
      }
    }
    ta.value = JSON.stringify(doc, null, 2);
  } catch {
    /* leave as-is if invalid */
  }
}

function applyAdvancedToControl(doc) {
  if (!doc || typeof doc !== "object") return;
  const c = doc.control || {};
  const s = doc.settings || doc;
  if (c.modelId) {
    ensureModelOption(c.modelId);
    document.getElementById("model").value = c.modelId;
  }
  if (c.context) document.getElementById("ctx").value = String(c.context);
  if (c.gpu) document.getElementById("gpu").value = c.gpu;
  if (c.parallel != null) document.getElementById("parallel").value = c.parallel;
  if (typeof s.pleCpu === "boolean") setToggle("tog-ple", s.pleCpu);
  if (s.lazyMode) document.getElementById("lazy").value = s.lazyMode;
  if (s.loadMode) document.getElementById("loadmode").value = s.loadMode;
  if (s.nCpuMoe != null) document.getElementById("ncpu").value = s.nCpuMoe;
  if (s.gpuLayers) document.getElementById("ngl").value = s.gpuLayers;
  if (s.kvQuant) document.getElementById("kvquant").value = s.kvQuant;
  if (typeof s.mmproj === "boolean") setToggle("tog-mmproj", s.mmproj);
  applyReasoningToForm(s);
}

function applyReasoningToForm(s = {}) {
  const sel = document.getElementById("reasoning");
  let effort = s.reasoningEffort || s.reasoning;
  if (!effort && typeof s.thinking === "boolean") {
    effort = s.thinking ? "low" : "off";
  }
  effort = String(effort || "low").toLowerCase();
  if (effort === "none" || effort === "false") effort = "off";
  if (![...sel.options].some((o) => o.value === effort)) {
    effort = "low";
  }
  sel.value = effort;
}

function applyConfigToForm(cfg) {
  config = cfg;
  hostLabel(cfg);
  document.getElementById("conn-host").value = cfg.host || "";
  document.getElementById("conn-port").value = cfg.port || 1234;
  document.getElementById("conn-user").value = cfg.sshUser || "";
  document.getElementById("conn-sshport").value = cfg.sshPort || 22;
  document.getElementById("conn-key").value = cfg.sshKeyPath || "";
  document.getElementById("conn-apikey").value = "";
  document.getElementById("conn-pass").value = "";
  document.getElementById("conn-apikey").placeholder = cfg.apiKeySet
    ? "(saved — leave blank to keep)"
    : "(optional)";
  document.getElementById("conn-pass").placeholder = cfg.sshPasswordSet
    ? "(saved — leave blank to keep)"
    : "(or use key path)";

  const c = cfg.control || {};
  ensureModelOption(c.modelId || "ud");
  document.getElementById("model").value = c.modelId || "ud";
  document.getElementById("ctx").value = String(c.context || 32768);
  document.getElementById("gpu").value = c.gpu || "max";
  document.getElementById("parallel").value = c.parallel || 1;

  const s = cfg.settings || {};
  setToggle("tog-ple", s.pleCpu !== false);
  document.getElementById("lazy").value = s.lazyMode || "off";
  document.getElementById("loadmode").value = s.loadMode || "dio";
  document.getElementById("ncpu").value = s.nCpuMoe ?? 0;
  document.getElementById("ngl").value = s.gpuLayers || "all";
  document.getElementById("kvquant").value = s.kvQuant || "q8_0";
  setToggle("tog-mmproj", s.mmproj !== false);
  applyReasoningToForm(s);

  if (cfg.advancedRaw) {
    document.getElementById("advanced-raw").value = cfg.advancedRaw;
  } else {
    syncAdvancedFromControl();
  }
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  el.classList.toggle("on", on);
  el.setAttribute("aria-checked", on ? "true" : "false");
}

function ensureModelOption(id) {
  const sel = document.getElementById("model");
  if (![...sel.options].some((o) => o.value === id)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    sel.appendChild(opt);
  }
}

function fillModels(models) {
  const sel = document.getElementById("model");
  const current = sel.value || config?.control?.modelId || "ud";
  sel.innerHTML = "";
  const seen = new Set();
  for (const m of models || []) {
    const id = m.id || m;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = m.label && m.label !== id ? `${id} — ${m.label}` : id;
    sel.appendChild(opt);
  }
  if (!seen.has("ud")) {
    const opt = document.createElement("option");
    opt.value = "ud";
    opt.textContent = "ud";
    sel.appendChild(opt);
  }
  ensureModelOption(current);
  sel.value = seen.has(current) ? current : "ud";
}

function tempBand(tempC) {
  if (tempC == null) return { cls: "", color: "#4ae89a", pct: 0 };
  // Map 35–90°C → 0–100 for dial; color cool→crit
  const pct = Math.max(0, Math.min(100, ((tempC - 30) / 60) * 100));
  let cls = "temp-cool";
  let color = "#3dff9a";
  if (tempC >= 82) {
    cls = "temp-crit";
    color = "#ff4d4d";
  } else if (tempC >= 72) {
    cls = "temp-hot";
    color = "#ff8a3d";
  } else if (tempC >= 58) {
    cls = "temp-warm";
    color = "#f0c45a";
  }
  return { cls, color, pct };
}

function powerPresetsFor(g) {
  const min = g.powerMinW ?? 100;
  const def = g.powerDefaultW ?? g.powerLimitW ?? min;
  const max = g.powerMaxW ?? def;
  const span = Math.max(1, max - min);
  return {
    eco: Math.round(min + span * 0.2),
    longJob: Math.round(min + span * 0.45),
    default: Math.round(def),
    boost: Math.round(max),
  };
}

function renderGpus(_gpus) {
  // Removed duplicate live-strip GPU cards — Monitor dials are the single GPU view.
}

function renderGpuGauges(gpus) {
  const box = document.getElementById("gpu-gauges");
  if (!box) return;
  if (!gpus?.length) {
    box.innerHTML = "";
    return;
  }
  // Arc length for path roughly semicircle r=40 → π*40 ≈ 125.6
  const ARC = 126;
  box.innerHTML = gpus
    .map((g) => {
      const band = tempBand(g.tempC);
      const offset = ARC - (ARC * band.pct) / 100;
      const util = g.utilPct ?? 0;
      const vramPct =
        g.vramUsedMiB != null && g.vramTotalMiB
          ? Math.round((g.vramUsedMiB / g.vramTotalMiB) * 100)
          : 0;
      const vram =
        g.vramUsedMiB != null && g.vramTotalMiB != null
          ? `${(Math.round((g.vramUsedMiB / 1024) * 10) / 10)}/${(Math.round((g.vramTotalMiB / 1024) * 10) / 10)}G`
          : "—";
      const pwr =
        g.powerW != null
          ? `${Math.round(g.powerW)}W`
          : "—";
      const lim =
        g.powerLimitW != null ? ` / ${Math.round(g.powerLimitW)}W` : "";
      const fan =
        g.fanPct != null
          ? ` · fan ${g.fanPct}%`
          : g.name === "CMP"
            ? " · fan n/a"
            : "";
      return `<div class="gauge ${band.cls}" style="--g-accent:${band.color}">
        <svg class="gauge-svg" viewBox="0 0 100 62" aria-hidden="true">
          <path class="track" d="M 12 54 A 38 38 0 0 1 88 54" />
          <path class="arc" d="M 12 54 A 38 38 0 0 1 88 54"
            stroke-dasharray="${ARC}" stroke-dashoffset="${offset}" />
        </svg>
        <div class="gauge-readout">${g.tempC != null ? `${g.tempC}°` : "—"}</div>
        <div class="gauge-label">${g.index} ${escapeHtml(g.name)}</div>
        <div class="gauge-meta">${util}% · ${vram}<br>${pwr}${lim}${fan}</div>
        <div class="gbar" title="GPU util"><i style="width:${util}%"></i></div>
        <div class="gbar2" title="VRAM"><i style="width:${vramPct}%"></i></div>
      </div>`;
    })
    .join("");
}

function renderPowerPanel(gpus) {
  const box = document.getElementById("power-panel");
  if (!box) return;
  if (!gpus?.length) {
    box.innerHTML = `<div class="hint">No GPU power data yet.</div>`;
    return;
  }
  // Don't rebuild if user is dragging a slider
  if (box.querySelector(".power-slider:active")) return;

  box.innerHTML = gpus
    .map((g) => {
      const min = Math.round(g.powerMinW ?? 100);
      const max = Math.round(g.powerMaxW ?? 300);
      const cur = Math.round(g.powerLimitW ?? g.powerDefaultW ?? max);
      const draw = g.powerW != null ? Math.round(g.powerW) : "—";
      const p = powerPresetsFor(g);
      return `<div class="power-card" data-gpu="${g.index}">
        <div class="ph">
          <b>${g.index} ${escapeHtml(g.name)}</b>
          <span>now ${draw}W · limit <b class="plim">${cur}</b>W · ${min}–${max}</span>
        </div>
        <input class="power-slider" type="range" min="${min}" max="${max}" step="5" value="${cur}" data-index="${g.index}" />
        <div class="power-presets">
          <button type="button" data-index="${g.index}" data-w="${p.eco}">Eco ${p.eco}W</button>
          <button type="button" data-index="${g.index}" data-w="${p.longJob}">Long job ${p.longJob}W</button>
          <button type="button" data-index="${g.index}" data-w="${p.default}">Default ${p.default}W</button>
          <button type="button" data-index="${g.index}" data-w="${p.boost}">Boost ${p.boost}W</button>
          <button type="button" class="primary" data-apply="${g.index}">Apply</button>
        </div>
      </div>`;
    })
    .join("");
}

let lastPowerGpuKey = "";
function maybeRenderPowerPanel(gpus) {
  const key = (gpus || [])
    .map(
      (g) =>
        `${g.index}:${Math.round(g.powerLimitW || 0)}:${Math.round(g.powerMinW || 0)}:${Math.round(g.powerMaxW || 0)}`,
    )
    .join("|");
  // Refresh panel when limits change or first paint; keep slider edits otherwise
  const box = document.getElementById("power-panel");
  const focused = box?.contains(document.activeElement);
  if (!focused && key !== lastPowerGpuKey) {
    lastPowerGpuKey = key;
    renderPowerPanel(gpus);
  } else if (!box?.innerHTML) {
    renderPowerPanel(gpus);
  } else {
    // Update live draw / limit labels without nuking sliders
    for (const g of gpus || []) {
      const card = box.querySelector(`.power-card[data-gpu="${g.index}"]`);
      if (!card) continue;
      const span = card.querySelector(".ph span");
      const draw = g.powerW != null ? Math.round(g.powerW) : "—";
      const lim = Math.round(g.powerLimitW ?? 0);
      const min = Math.round(g.powerMinW ?? 100);
      const max = Math.round(g.powerMaxW ?? 300);
      if (span) {
        span.innerHTML = `now ${draw}W · limit <b class="plim">${lim}</b>W · ${min}–${max}`;
      }
    }
  }
}

async function applyGpuPower(index, watts) {
  setStatus("status-power", `Setting GPU ${index} → ${watts}W…`);
  try {
    const r = await api("/api/gpu-power", {
      method: "POST",
      body: JSON.stringify({ index, watts }),
    });
    if (r.ok) {
      setStatus(
        "status-power",
        `<span class="ok">GPU ${r.index}</span> limit ${r.applied}W (range ${r.minW}–${r.maxW})`,
      );
      lastPowerGpuKey = "";
      refreshMetrics();
    } else {
      setStatus(
        "status-power",
        `<span class="err">${escapeHtml(r.error || r.note || "Failed")}</span>`,
      );
    }
  } catch (e) {
    setStatus("status-power", `<span class="err">${escapeHtml(e.message)}</span>`);
  }
}

document.getElementById("power-panel")?.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-w], button[data-apply]");
  if (!btn) return;
  const card = btn.closest(".power-card");
  const slider = card?.querySelector(".power-slider");
  if (btn.hasAttribute("data-w")) {
    const w = Number(btn.getAttribute("data-w"));
    if (slider) slider.value = String(w);
    const plim = card.querySelector(".plim");
    if (plim) plim.textContent = String(w);
  }
  if (btn.hasAttribute("data-apply") || btn.hasAttribute("data-w")) {
    const index = Number(btn.getAttribute("data-index") || btn.getAttribute("data-apply"));
    const watts = Number(slider?.value);
    if (Number.isFinite(index) && Number.isFinite(watts)) {
      applyGpuPower(index, watts);
    }
  }
});

document.getElementById("power-panel")?.addEventListener("input", (e) => {
  const sl = e.target.closest(".power-slider");
  if (!sl) return;
  const card = sl.closest(".power-card");
  const plim = card?.querySelector(".plim");
  if (plim) plim.textContent = sl.value;
});

function renderMetrics(m) {
  const model = m.model?.id || "—";
  document.getElementById("live-model").textContent = model;
  const st = document.getElementById("live-state");
  const state = m.state || "idle";
  st.textContent = state;
  st.className = "state " + (state === "idle" ? "idle" : "on");

  document.getElementById("m-tps").textContent =
    m.tps != null ? Number(m.tps).toFixed(1) : "—";
  document.getElementById("m-cpu").textContent =
    m.cpuPct != null ? m.cpuPct : "—";
  document.getElementById("m-ctx").textContent =
    m.context != null
      ? formatCtx(m.context)
      : m.loaded?.[0]?.contextLength != null
        ? formatCtx(m.loaded[0].contextLength)
        : "—";
  const ram = m.ram || {};
  document.getElementById("m-ram").textContent =
    ram.ramTotalGiB != null
      ? `${ram.ramUsedGiB}/${ram.ramTotalGiB}G`
      : "—";
  renderGpus(m.gpus);
  renderGpuGauges(m.gpus);
  maybeRenderPowerPanel(m.gpus);
  document.getElementById("activity").innerHTML = escapeHtml(m.activity || "");
  if (m.errors?.length && !m.gpus?.length) {
    document.getElementById("activity").innerHTML =
      `<span class="wn">${escapeHtml(m.errors[0])}</span>`;
  }

  // Detailed monitor panel
  const load = m.loadavg;
  document.getElementById("d-load").textContent = load
    ? `${load[0]} ${load[1]} ${load[2]}`
    : "—";
  document.getElementById("d-threads").textContent =
    m.cpuPct != null
      ? `${m.cpuPct}% · ${m.cpuThreads != null ? m.cpuThreads + " thr" : ""}${m.cpuModel ? ` · ${m.cpuModel}` : ""}`
      : m.cpuThreads != null
        ? `${m.cpuThreads} threads${m.cpuModel ? ` · ${m.cpuModel}` : ""}`
        : "—";
  document.getElementById("d-ram").textContent =
    ram.ramTotalGiB != null
      ? `${ram.ramUsedGiB} / ${ram.ramTotalGiB} GiB (${ram.ramPct ?? "—"}%)`
      : "—";
  const sw = m.swap || {};
  document.getElementById("d-swap").textContent =
    sw.swapTotalGiB != null
      ? `${sw.swapUsedGiB} / ${sw.swapTotalGiB} GiB`
      : "—";
  const disk = m.disk || {};
  document.getElementById("d-disk").textContent =
    disk.totalGiB != null
      ? `${disk.usedGiB} / ${disk.totalGiB} GiB (${disk.pct ?? "—"}%)`
      : "—";
  document.getElementById("d-parallel").textContent =
    m.parallel != null ? String(m.parallel) : "—";

  // Moving bars
  const setBar = (id, pct) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${Math.max(0, Math.min(100, pct || 0))}%`;
  };
  setBar("bar-cpu", m.cpuPct);
  setBar("bar-ram", ram.ramPct);
  setBar("bar-disk", disk.pct);
  if (load?.[0] != null && m.cpuThreads) {
    setBar("bar-load", (load[0] / m.cpuThreads) * 100);
  }

  const loaded = m.loaded || [];
  document.getElementById("d-loaded").textContent = loaded.length
    ? loaded
        .map(
          (x) =>
            `${x.id} · ${x.status || "loaded"}${x.contextLength ? ` · ctx ${x.contextLength}` : ""}${x.parallel != null ? ` · p${x.parallel}` : ""}`,
        )
        .join("\n")
    : "(none loaded)";

  document.getElementById("d-host").textContent = [
    m.hostname ? `host ${m.hostname}` : null,
    m.uptime ? `uptime ${m.uptime}` : null,
    m.host && m.port != null ? `lms ${m.host}:${m.port}` : null,
    m.apiOk != null ? `api ${m.apiOk ? "ok" : "down"}` : null,
  ]
    .filter(Boolean)
    .join("\n") || "—";
}

function formatCtx(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

async function refreshMetrics() {
  try {
    const m = await api("/api/metrics");
    renderMetrics(m);
  } catch (e) {
    document.getElementById("activity").innerHTML =
      `<span class="wn">${escapeHtml(e.message)}</span>`;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  const ms = config?.pollMs || 2000;
  pollTimer = setInterval(refreshMetrics, ms);
  refreshMetrics();
}

function readAdvancedPayload() {
  const raw = document.getElementById("advanced-raw").value;
  let advanced = { extras: {} };
  let settings = readSettingsGuiOnly();
  let control = readControl();
  try {
    const doc = JSON.parse(raw);
    if (doc.control) control = { ...control, ...doc.control };
    if (doc.settings) settings = { ...settings, ...doc.settings };
    if (doc.extras) advanced.extras = doc.extras;
    advanced = { ...advanced, ...omit(doc, ["control", "settings"]) };
  } catch (e) {
    const err = new Error("Advanced JSON is invalid: " + e.message);
    throw err;
  }
  return {
    control,
    settings,
    advanced,
    advancedRaw: raw,
  };
}

function readSettingsGuiOnly() {
  const effort = document.getElementById("reasoning").value || "low";
  return {
    pleCpu: document.getElementById("tog-ple").classList.contains("on"),
    lazyMode: document.getElementById("lazy").value,
    loadMode: document.getElementById("loadmode").value,
    nCpuMoe: Number(document.getElementById("ncpu").value) || 0,
    gpuLayers: document.getElementById("ngl").value || "all",
    kvQuant: document.getElementById("kvquant").value,
    mmproj: document.getElementById("tog-mmproj").classList.contains("on"),
    reasoningEffort: effort,
    thinking: effort !== "off",
  };
}

async function persistAll() {
  syncAdvancedFromControl();
  const payload = readAdvancedPayload();
  // Merge GUI settings over parsed (GUI is source of truth for known keys when saving from Control)
  payload.settings = { ...payload.settings, ...readSettingsGuiOnly() };
  payload.control = readControl();
  payload.advancedRaw = document.getElementById("advanced-raw").value;
  return api("/api/config", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

document.getElementById("btn-save").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setStatus("status-control", "Saving…");
  try {
    syncAdvancedFromControl();
    await persistAll();
    const r = await api("/api/save-settings", {
      method: "POST",
      body: JSON.stringify({
        control: readControl(),
        settings: readSettingsGuiOnly(),
      }),
    });
    setStatus(
      "status-control",
      r.ok
        ? `Saved <span class="ok">${escapeHtml(r.modelId)}</span> · ctx ${r.settings?.context} · gpu ${escapeHtml(String(r.settings?.gpu))} · parallel ${r.settings?.parallel}`
        : `<span class="err">Save failed</span> · ${escapeHtml(r.stderr || r.error || "")}`,
    );
  } catch (e) {
    setStatus("status-control", `<span class="err">${escapeHtml(e.message)}</span>`);
  } finally {
    busy = false;
  }
});

document.getElementById("btn-save-advanced").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setStatus("status-advanced", "Saving…");
  try {
    const payload = readAdvancedPayload();
    applyAdvancedToControl(payload);
    const r = await api("/api/config", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    config = r.config;
    await api("/api/save-settings", {
      method: "POST",
      body: JSON.stringify({
        control: payload.control,
        settings: payload.settings,
      }),
    });
    setStatus("status-advanced", `<span class="ok">Advanced saved</span> · sidecar updated`);
  } catch (e) {
    setStatus("status-advanced", `<span class="err">${escapeHtml(e.message)}</span>`);
  } finally {
    busy = false;
  }
});

document.getElementById("btn-reset-advanced").addEventListener("click", () => {
  const ta = document.getElementById("advanced-raw");
  // force rewrite from GUI
  const doc = buildAdvancedDocument();
  ta.value = JSON.stringify(doc, null, 2);
  setStatus("status-advanced", "Reset from Control fields");
});

document.getElementById("btn-unload").addEventListener("click", async () => {
  if (busy) return;
  if (!confirm("Unload all models on the remote LMS host?")) return;
  busy = true;
  setStatus("status-control", "Unloading…");
  try {
    const r = await api("/api/unload-all", { method: "POST", body: "{}" });
    setStatus(
      "status-control",
      r.ok
        ? `<span class="ok">Unload all</span> · done`
        : `<span class="err">Unload failed</span> · ${escapeHtml(r.stderr || "")}`,
    );
    await refreshMetrics();
  } catch (e) {
    setStatus("status-control", `<span class="err">${escapeHtml(e.message)}</span>`);
  } finally {
    busy = false;
  }
});

document.getElementById("btn-load").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  const btn = document.getElementById("btn-load");
  btn.disabled = true;
  setStatus("status-control", "Load now… (may take a few minutes)");
  try {
    syncAdvancedFromControl();
    await persistAll();
    const r = await api("/api/load-now", {
      method: "POST",
      body: JSON.stringify({
        control: readControl(),
        settings: readSettingsGuiOnly(),
      }),
    });
    const bits = [
      r.ok
        ? `<span class="ok">Loaded ${escapeHtml(r.modelId)}</span>`
        : `<span class="err">Load issue</span>`,
      `ctx ${r.applied?.ctx}`,
      `gpu ${escapeHtml(String(r.applied?.gpu))}`,
      `parallel ${r.applied?.parallel}`,
    ];
    setStatus("status-control", bits.join(" · "));
    await refreshMetrics();
  } catch (e) {
    setStatus("status-control", `<span class="err">${escapeHtml(e.message)}</span>`);
  } finally {
    btn.disabled = false;
    busy = false;
  }
});

["model", "ctx", "gpu", "parallel", "lazy", "loadmode", "ncpu", "ngl", "kvquant", "reasoning"].forEach(
  (id) => {
    document.getElementById(id)?.addEventListener("change", syncAdvancedFromControl);
  },
);

document.getElementById("btn-save-conn").addEventListener("click", async () => {
  const body = {
    host: document.getElementById("conn-host").value.trim(),
    port: Number(document.getElementById("conn-port").value) || 1234,
    sshUser: document.getElementById("conn-user").value.trim(),
    sshPort: Number(document.getElementById("conn-sshport").value) || 22,
    sshKeyPath: document.getElementById("conn-key").value.trim(),
  };
  const apiKey = document.getElementById("conn-apikey").value;
  const pass = document.getElementById("conn-pass").value;
  if (apiKey) body.apiKey = apiKey;
  if (pass) body.sshPassword = pass;
  try {
    const r = await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    applyConfigToForm(r.config);
    setStatus("status-conn", `<span class="ok">Connection saved</span> locally`);
    startPolling();
    refreshModels();
  } catch (e) {
    setStatus("status-conn", `<span class="err">${escapeHtml(e.message)}</span>`);
  }
});

document.getElementById("btn-test-conn").addEventListener("click", async () => {
  setStatus("status-conn", "Testing…");
  try {
    await document.getElementById("btn-save-conn").click();
    const r = await api("/api/test-connection", { method: "POST", body: "{}" });
    const ssh = r.ssh?.ok ? "SSH ok" : `SSH fail: ${r.ssh?.error || r.ssh?.stderr || ""}`;
    const apiBit = r.api?.ok ? "API ok" : `API fail: ${r.api?.error || r.api?.status || ""}`;
    setStatus(
      "status-conn",
      r.ok
        ? `<span class="ok">Connected</span> · ${escapeHtml(ssh)} · ${escapeHtml(apiBit)}`
        : `<span class="err">Partial</span> · ${escapeHtml(ssh)} · ${escapeHtml(apiBit)}`,
    );
    await refreshMetrics();
  } catch (e) {
    setStatus("status-conn", `<span class="err">${escapeHtml(e.message)}</span>`);
  }
});

async function refreshModels() {
  try {
    const r = await api("/api/models");
    if (r.models?.length) fillModels(r.models);
  } catch {
    /* keep existing */
  }
}

async function boot() {
  setMode("monitor");
  try {
    const cfg = await api("/api/config");
    applyConfigToForm(cfg);
  } catch (e) {
    setStatus("status-conn", `<span class="err">${escapeHtml(e.message)}</span>`);
  }
  startPolling();
  refreshModels();
}

boot();

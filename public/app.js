const tool = document.getElementById("tool");
const foot = document.getElementById("foot");
const panels = {
  control: document.getElementById("panel-control"),
  settings: document.getElementById("panel-settings"),
  connection: document.getElementById("panel-connection"),
};

let config = null;
let pollTimer = null;
let busy = false;

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
  if (tab === "monitor") {
    tool.classList.add("mode-monitor");
    foot.textContent = "LMS Buddy · Monitor · metrics only";
  } else {
    tool.classList.remove("mode-monitor");
    panels[tab]?.classList.add("active");
    foot.textContent = `LMS Buddy · ${tab[0].toUpperCase()}${tab.slice(1)}`;
  }
}

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => setMode(t.dataset.tab));
});

document.querySelectorAll(".toggle").forEach((el) => {
  el.addEventListener("click", () => {
    el.classList.toggle("on");
    el.setAttribute("aria-checked", el.classList.contains("on"));
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
  return {
    pleCpu: document.getElementById("tog-ple").classList.contains("on"),
    lazyMode: document.getElementById("lazy").value,
    loadMode: document.getElementById("loadmode").value,
    nCpuMoe: Number(document.getElementById("ncpu").value) || 0,
    gpuLayers: document.getElementById("ngl").value || "all",
    kvQuant: document.getElementById("kvquant").value,
    mmproj: document.getElementById("tog-mmproj").classList.contains("on"),
    thinking: document.getElementById("tog-think").classList.contains("on"),
  };
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
  setToggle("tog-think", Boolean(s.thinking));
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

function renderGpus(gpus) {
  const box = document.getElementById("gpus");
  if (!gpus?.length) {
    box.innerHTML = `<div class="gpu"><div class="n">GPU</div><div class="t">—</div></div>`;
    return;
  }
  box.innerHTML = gpus
    .map((g) => {
      const hot = g.tempC != null && g.tempC >= 72 ? " hot" : "";
      const temp = g.tempC != null ? `${g.tempC}°` : "—";
      const util = g.utilPct != null ? g.utilPct : 0;
      const vram =
        g.vramUsedMiB != null && g.vramTotalMiB != null
          ? `${Math.round(g.vramUsedMiB / 1024 * 10) / 10}/${Math.round(g.vramTotalMiB / 1024 * 10) / 10}G`
          : "";
      const fan =
        g.fanPct != null ? ` · fan ${g.fanPct}%` : g.name === "CMP" ? " · fan n/a" : "";
      return `<div class="gpu">
        <div class="n">${g.index} ${escapeHtml(g.name)}</div>
        <div class="t${hot}">${temp}</div>
        <div class="sub">${util}%${vram ? ` · ${vram}` : ""}${fan}</div>
        <div class="gbar"><i style="width:${util}%"></i></div>
      </div>`;
    })
    .join("");
}

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
  document.getElementById("activity").innerHTML = escapeHtml(m.activity || "");
  if (m.errors?.length && !m.gpus?.length) {
    document.getElementById("activity").innerHTML =
      `<span class="wn">${escapeHtml(m.errors[0])}</span>`;
  }
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

async function persistControlSettings() {
  return api("/api/config", {
    method: "PUT",
    body: JSON.stringify({
      control: readControl(),
      settings: readSettings(),
    }),
  });
}

document.getElementById("btn-save").addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  setStatus("status-control", "Saving…");
  try {
    await persistControlSettings();
    const r = await api("/api/save-settings", {
      method: "POST",
      body: JSON.stringify({
        control: readControl(),
        settings: readSettings(),
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

document.getElementById("btn-save-settings").addEventListener("click", () => {
  document.getElementById("btn-save").click();
  setStatus("status-settings", "Delegated to Save settings…");
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
    await persistControlSettings();
    const r = await api("/api/load-now", {
      method: "POST",
      body: JSON.stringify({
        control: readControl(),
        settings: readSettings(),
      }),
    });
    const bits = [
      r.ok ? `<span class="ok">Loaded ${escapeHtml(r.modelId)}</span>` : `<span class="err">Load issue</span>`,
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
    // Save first so test uses form values
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

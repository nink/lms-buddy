import { sshExec, bashQuote } from "./ssh.js";
import { listModels, healthCheck } from "./lms-http.js";
import { loadConfig } from "./config.js";

function parseNvidiaSmi(csv) {
  const gpus = [];
  const lines = csv
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    // index, name, temp, util, mem used/total, fan, power draw, limit, default, min, max
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 6) continue;
    const [
      index,
      name,
      temp,
      util,
      memUsed,
      memTotal,
      fan,
      power,
      powerLimit,
      powerDefault,
      powerMin,
      powerMax,
    ] = parts;
    const tempN = Number(temp);
    const utilN = Number(util);
    const used = Number(memUsed);
    const total = Number(memTotal);
    const powerN = Number(power);
    const lim = Number(powerLimit);
    const def = Number(powerDefault);
    const minL = Number(powerMin);
    const maxL = Number(powerMax);
    gpus.push({
      index: Number(index),
      name: shortGpuName(name),
      fullName: name,
      tempC: Number.isFinite(tempN) ? tempN : null,
      utilPct: Number.isFinite(utilN) ? utilN : null,
      vramUsedMiB: Number.isFinite(used) ? used : null,
      vramTotalMiB: Number.isFinite(total) ? total : null,
      fanPct: fan && fan !== "[N/A]" && fan !== "N/A" ? Number(fan) : null,
      powerW: Number.isFinite(powerN) ? powerN : null,
      powerLimitW: Number.isFinite(lim) ? lim : null,
      powerDefaultW: Number.isFinite(def) ? def : null,
      powerMinW: Number.isFinite(minL) ? minL : null,
      powerMaxW: Number.isFinite(maxL) ? maxL : null,
    });
  }
  return gpus;
}

function shortGpuName(name) {
  const n = String(name || "");
  if (/CMP/i.test(n) || /170HX/i.test(n)) return "CMP";
  if (/3090/i.test(n)) return "3090";
  if (/3080/i.test(n)) return "3080";
  if (/4090/i.test(n)) return "4090";
  if (/A6000/i.test(n)) return "A6000";
  const m = n.match(/GeForce\s+RTX\s+(\S+)/i) || n.match(/RTX\s+(\S+)/i);
  if (m) return m[1];
  return n.replace(/^NVIDIA\s+/i, "").slice(0, 12);
}

function parseMemInfo(stdout) {
  const total = Number((stdout.match(/MemTotal:\s+(\d+)/) || [])[1]);
  const avail = Number((stdout.match(/MemAvailable:\s+(\d+)/) || [])[1]);
  const swapTotal = Number((stdout.match(/SwapTotal:\s+(\d+)/) || [])[1]);
  const swapFree = Number((stdout.match(/SwapFree:\s+(\d+)/) || [])[1]);
  const out = {
    ramUsedGiB: null,
    ramTotalGiB: null,
    ramPct: null,
  };
  if (total) {
    const usedKiB = total - (avail || 0);
    out.ramUsedGiB = +(usedKiB / 1024 / 1024).toFixed(1);
    out.ramTotalGiB = +(total / 1024 / 1024).toFixed(1);
    out.ramPct = Math.round((usedKiB / total) * 100);
  }
  const swap = {
    swapUsedGiB: null,
    swapTotalGiB: null,
  };
  if (swapTotal) {
    const used = swapTotal - (swapFree || 0);
    swap.swapUsedGiB = +(used / 1024 / 1024).toFixed(1);
    swap.swapTotalGiB = +(swapTotal / 1024 / 1024).toFixed(1);
  }
  return { ram: out, swap };
}

function parseLoadAvg(stdout) {
  const m = stdout.trim().match(/^([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])].map((n) => +n.toFixed(2));
}

function parseDisk(stdout) {
  // df -BG /  -> Filesystem Size Used Avail Use% Mounted
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const data = lines.find((l) => l.startsWith("/") || /\s\/$/.test(l)) || lines[1];
  if (!data) return {};
  const parts = data.trim().split(/\s+/);
  // size used avail pct mount — units may be "120G"
  const num = (s) => Number(String(s).replace(/G/i, ""));
  if (parts.length >= 5) {
    const total = num(parts[1]);
    const used = num(parts[2]);
    const pct = Number(String(parts[4]).replace("%", ""));
    return {
      totalGiB: Number.isFinite(total) ? total : null,
      usedGiB: Number.isFinite(used) ? used : null,
      pct: Number.isFinite(pct) ? pct : null,
    };
  }
  return {};
}

function parseUptime(stdout) {
  // uptime -p => "up 2 weeks, 3 days, ..."
  const t = stdout.trim();
  return t.replace(/^up\s+/i, "") || null;
}

function parseCpuIdle(stdout) {
  // First line of /proc/stat: cpu user nice system idle iowait ...
  const m = stdout.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m);
  if (!m) return null;
  const user = Number(m[1]);
  const nice = Number(m[2]);
  const system = Number(m[3]);
  const idle = Number(m[4]);
  const total = user + nice + system + idle;
  if (!total) return null;
  return { idle, total };
}

function cpuPctFromSamples(a, b) {
  if (!a || !b) return null;
  const idleDelta = b.idle - a.idle;
  const totalDelta = b.total - a.total;
  if (totalDelta <= 0) return null;
  const busy = 1 - idleDelta / totalDelta;
  return Math.round(Math.max(0, Math.min(100, busy * 100)));
}

/**
 * Best-effort parse of `lms ps` JSON or table output.
 */
function parseLmsPs(stdout) {
  const text = stdout.trim();
  if (!text || text === "[]") return { loaded: [], raw: text };

  // Try JSON first (newer lms)
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j) && j.length === 0) return { loaded: [], raw: text };
    const arr = Array.isArray(j) ? j : j?.models || j?.data || [];
    if (Array.isArray(arr)) {
      return {
        loaded: arr.map((m) => ({
          id: m.identifier || m.modelKey || m.id || m.path || "?",
          modelKey: m.modelKey || m.path || m.id,
          status: m.status || "loaded",
          contextLength: m.contextLength || m.config?.contextLength || null,
          parallel: m.parallel ?? m.maxParallelPredictions ?? null,
          ttl: m.ttl ?? null,
        })),
        raw: text,
      };
    }
  } catch {
    /* table */
  }

  const loaded = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  for (const line of lines) {
    if (/^IDENTIFIER|^MODEL|^─|^-/i.test(line)) continue;
    if (/no models? loaded/i.test(line)) continue;
    if (line.trim() === "[]") continue;
    const cols = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
    if (cols.length >= 1) {
      const id = cols[0];
      if (!id || id === "identifier" || id === "[]") continue;
      loaded.push({
        id,
        modelKey: cols[1] || id,
        status: /generat|run|busy/i.test(line) ? "busy" : "loaded",
        contextLength: null,
        ttl: null,
        line,
      });
    }
  }
  return { loaded, raw: text };
}

export async function collectMetrics(cfg = loadConfig()) {
  const nvidiaCmd =
    "nvidia-smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw,power.limit,power.default_limit,power.min_limit,power.max_limit --format=csv,noheader,nounits 2>/dev/null";
  const memCmd = "cat /proc/meminfo";
  const cpuCmd =
    "head -1 /proc/stat; sleep 0.35; head -1 /proc/stat";
  const psCmd =
    "lms ps --json 2>/dev/null || lms ps -j 2>/dev/null || lms ps 2>/dev/null";
  const loadCmd = "cat /proc/loadavg";
  const threadsCmd = "nproc 2>/dev/null; grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2";
  const diskCmd = "df -BG / 2>/dev/null | tail -1";
  const upCmd = "uptime -p 2>/dev/null || uptime";
  const hostCmd = "hostname";

  const combined = [
    `echo '---NVIDIA---'`,
    nvidiaCmd,
    `echo '---MEM---'`,
    memCmd,
    `echo '---CPU---'`,
    cpuCmd,
    `echo '---LMSPS---'`,
    psCmd,
    `echo '---LOAD---'`,
    loadCmd,
    `echo '---THREADS---'`,
    threadsCmd,
    `echo '---DISK---'`,
    diskCmd,
    `echo '---UP---'`,
    upCmd,
    `echo '---HOST---'`,
    hostCmd,
  ].join("; ");

  let gpus = [];
  let ram = { ramUsedGiB: null, ramTotalGiB: null, ramPct: null };
  let swap = { swapUsedGiB: null, swapTotalGiB: null };
  let cpuPct = null;
  let lmsPs = { loaded: [], raw: "" };
  let api = { ok: false, models: [] };
  let loadavg = null;
  let cpuThreads = null;
  let cpuModel = null;
  let disk = {};
  let uptime = null;
  let hostname = null;
  const errors = [];

  try {
    const r = await sshExec(combined, 20000, cfg);
    if (r.code !== 0 && !r.stdout.includes("---NVIDIA---")) {
      errors.push(`ssh: ${r.stderr || `exit ${r.code}`}`);
    } else {
      const sections = splitSections(r.stdout);
      try {
        gpus = parseNvidiaSmi(sections.NVIDIA || "");
      } catch (e) {
        errors.push(`nvidia-smi parse: ${e.message}`);
      }
      const mem = parseMemInfo(sections.MEM || "");
      ram = mem.ram;
      swap = mem.swap;
      const cpuLines = (sections.CPU || "").trim().split(/\r?\n/).filter(Boolean);
      if (cpuLines.length >= 2) {
        cpuPct = cpuPctFromSamples(
          parseCpuIdle(cpuLines[0]),
          parseCpuIdle(cpuLines[1]),
        );
      }
      lmsPs = parseLmsPs(sections.LMSPS || "");
      loadavg = parseLoadAvg(sections.LOAD || "");
      const th = (sections.THREADS || "").trim().split(/\r?\n/);
      cpuThreads = Number(th[0]) || null;
      cpuModel = (th[1] || "").trim() || null;
      if (cpuModel && cpuModel.length > 42) cpuModel = cpuModel.slice(0, 40) + "…";
      disk = parseDisk(sections.DISK || "");
      uptime = parseUptime(sections.UP || "");
      hostname = (sections.HOST || "").trim() || null;
    }
  } catch (e) {
    errors.push(`ssh: ${e.message}`);
  }

  try {
    api = await listModels(cfg);
  } catch (e) {
    errors.push(`api: ${e.message}`);
    api = { ok: false, models: [], error: e.message };
  }

  const primary =
    lmsPs.loaded[0] ||
    (api.models?.length === 1
      ? { id: api.models[0].id, modelKey: api.models[0].id, status: "api" }
      : null);

  let state = "idle";
  if (primary) {
    state = /busy|generat/i.test(primary.status || "") ? "busy" : "loaded";
  }

  return {
    ok: errors.length === 0 || gpus.length > 0 || Boolean(primary),
    ts: Date.now(),
    host: cfg.host,
    port: cfg.port,
    hostname,
    uptime,
    model: primary
      ? { id: primary.id, key: primary.modelKey, status: primary.status }
      : null,
    state,
    tps: null,
    promptTps: null,
    context: primary?.contextLength || null,
    parallel: primary?.parallel ?? null,
    ram,
    swap,
    loadavg,
    cpuThreads,
    cpuModel,
    disk,
    cpuPct,
    gpus,
    loaded: lmsPs.loaded,
    apiModels: api.models || [],
    apiOk: Boolean(api.ok),
    errors,
    activity: buildActivity({ state, primary, gpus, errors }),
  };
}

function splitSections(stdout) {
  const out = {};
  let cur = null;
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^---([A-Z]+)---$/);
    if (m) {
      cur = m[1];
      out[cur] = "";
      continue;
    }
    if (cur != null) out[cur] += line + "\n";
  }
  return out;
}

function buildActivity({ state, primary, gpus, errors }) {
  if (errors.length && !gpus.length) return `error · ${errors[0]}`;
  const hot = gpus.reduce(
    (a, g) => (g.tempC != null && (a == null || g.tempC > a.tempC) ? g : a),
    null,
  );
  if (state === "idle" || !primary) {
    return `idle · VRAM free · last ${primary?.id || "—"}`;
  }
  const hotBit =
    hot && hot.tempC != null
      ? `GPU${hot.index} ${hot.tempC}°`
      : "ok";
  return `${state} · ${primary.id} · ${hotBit}`;
}

export async function testConnection(cfg = loadConfig()) {
  const { sshTest } = await import("./ssh.js");
  const results = { ssh: null, api: null };
  try {
    results.ssh = await sshTest(cfg);
  } catch (e) {
    results.ssh = { ok: false, error: e.message };
  }
  try {
    results.api = await healthCheck(cfg);
  } catch (e) {
    results.api = { ok: false, error: e.message };
  }
  return {
    ok: Boolean(results.ssh?.ok && results.api?.ok),
    ...results,
  };
}

export { bashQuote };

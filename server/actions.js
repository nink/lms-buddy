import { sshExec, bashQuote } from "./ssh.js";
import { loadConfig, updateConfig } from "./config.js";

/**
 * Build LLM load flags that lms load understands:
 *   --gpu, --context-length, --parallel
 *
 * Advanced flags (PLE, lazy, load-mode, kv, mmproj, thinking / reasoningEffort)
 * are written best-effort into user-concrete-model-default-config + a buddy sidecar JSON.
 * Documented limits: JIT may ignore some; PLE/n-gram often needs wrapper/override.
 * reasoningEffort is primarily a *client* chat param (reasoning / reasoning_effort).
 */

export function normalizeReasoningEffort(settings = {}) {
  const raw = settings.reasoningEffort ?? settings.reasoning;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    if (["off", "none", "false", "0"].includes(v)) return "off";
    if (["low", "medium", "high", "on"].includes(v)) return v;
  }
  if (typeof settings.thinking === "boolean") {
    return settings.thinking ? "low" : "off";
  }
  return "low";
}

/** OpenAI-compatible reasoning_effort value (none disables). */
export function toOpenAiReasoningEffort(effort) {
  const e = normalizeReasoningEffort({ reasoningEffort: effort });
  if (e === "off") return "none";
  if (e === "on") return "high";
  return e;
}

export function buildLoadArgs(control = {}, settings = {}) {
  const modelId = control.modelId || "ud";
  const ctx = Number(control.context) || 32768;
  const parallel = Number(control.parallel) || 1;
  let gpu = control.gpu || "max";
  if (gpu === "CPU" || gpu === "off") gpu = "off";
  if (gpu === "custom…" || gpu === "custom") gpu = "max";

  const args = [
    "lms",
    "load",
    bashQuote(modelId),
    "--gpu",
    bashQuote(String(gpu)),
    "--context-length",
    String(ctx),
    "--parallel",
    String(parallel),
    "-y",
  ];

  // Best-effort llama.cpp-style extras via LMS if supported (ignored if unknown).
  // We do NOT pass unknown flags to avoid failing load; extras go to concrete config.
  return { modelId, ctx, parallel, gpu, cmd: args.join(" ") };
}

/**
 * Concrete default config fields LMS has been observed to honor for GGUF loads.
 * Keys use dotted llm.load.* form inside a fields array (model.yaml style) OR
 * flat object — we write both a buddy sidecar and attempt the internal dir.
 */
export function buildConcreteConfig(control, settings) {
  const fields = [];
  const ctx = Number(control.context) || 32768;
  fields.push({ key: "llm.load.contextLength", value: ctx });

  const gpu = control.gpu || "max";
  if (gpu === "max") {
    fields.push({ key: "llm.load.gpu.offloadRatio", value: 1 });
  } else if (gpu === "off" || gpu === "CPU") {
    fields.push({ key: "llm.load.gpu.offloadRatio", value: 0 });
  } else {
    const ratio = Number(gpu);
    if (Number.isFinite(ratio)) {
      fields.push({ key: "llm.load.gpu.offloadRatio", value: ratio });
    }
  }

  const parallel = Number(control.parallel) || 1;
  fields.push({ key: "llm.load.llama.nParallel", value: parallel });
  // Some builds use maxParallelPredictions naming via API only.

  if (settings.nCpuMoe != null) {
    fields.push({
      key: "llm.load.llama.acceleration.offloadRatio",
      value: settings.nCpuMoe > 0 ? undefined : undefined,
    });
  }

  // Flash / FA if present
  fields.push({ key: "llm.load.llama.flashAttention", value: true });

  // Strip undefined
  const clean = fields.filter((f) => f.value !== undefined);

  const reasoningEffort = normalizeReasoningEffort(settings);
  const thinking = reasoningEffort !== "off";
  const settingsNorm = {
    ...settings,
    reasoningEffort,
    thinking,
  };

  return {
    // Sidecar for LMS Buddy / wrappers
    buddy: {
      version: 1,
      modelId: control.modelId,
      control,
      settings: settingsNorm,
      clientApi: {
        "api/v1/chat": { reasoning: reasoningEffort },
        "v1/chat/completions": {
          reasoning_effort: toOpenAiReasoningEffort(reasoningEffort),
        },
        "v1/responses": {
          reasoning: {
            effort: toOpenAiReasoningEffort(reasoningEffort),
          },
        },
      },
      savedAt: new Date().toISOString(),
      notes: {
        ple:
          "PLE/n-gram → CPU usually needs --override-tensor or a server wrapper; not a first-class lms load flag.",
        lazyLoadMode:
          "lazy-mode / load-mode (dio/mmap/mlock) often require llama-server wrapper args.",
        kvQuant: "KV quant may only apply via engine/wrapper; concrete config best-effort.",
        reasoning:
          "Pass clientApi fields on chat requests. Some models only support off/on; low/medium/high need effort-aware models.",
        jit: "OpenAI JIT load has historically ignored some per-model defaults — prefer lms load or Load now.",
      },
    },
    // Attempted LMS concrete shape (flat map + fields array)
    concrete: {
      "llm.load.contextLength": ctx,
      fields: clean,
    },
  };
}

export async function saveModelDefaults(cfg = loadConfig()) {
  const control = cfg.control || {};
  const settings = cfg.settings || {};
  const modelId = control.modelId || "ud";
  const built = buildConcreteConfig(control, settings);
  const loadInfo = buildLoadArgs(control, settings);

  const remoteBuddyDir = "~/.lms-buddy";
  const remoteConcreteDir =
    "~/.lmstudio/.internal/user-concrete-model-default-config";
  const safeName = String(modelId).replace(/[^\w.\-]+/g, "_");

  const buddyJson = JSON.stringify(built.buddy, null, 2);
  const concreteJson = JSON.stringify(built.concrete, null, 2);

  // Write via SSH using a python one-liner for reliable escaping
  const script = `
set -e
mkdir -p ${remoteBuddyDir}
mkdir -p ${remoteConcreteDir}
mkdir -p ${remoteConcreteDir}/buddy
python3 - <<'PY'
import json, os, pathlib
buddy = json.loads(${JSON.stringify(buddyJson)})
concrete = json.loads(${JSON.stringify(concreteJson)})
home = pathlib.Path.home()
buddy_path = home / ".lms-buddy" / ${JSON.stringify(safeName + ".json")}
buddy_path.write_text(json.dumps(buddy, indent=2))
# Also write under concrete dir with model id basename (LMS layout varies by publisher)
conc_dir = home / ".lmstudio" / ".internal" / "user-concrete-model-default-config"
conc_dir.mkdir(parents=True, exist_ok=True)
# Flat file for our tooling
(conc_dir / "buddy").mkdir(exist_ok=True)
(conc_dir / "buddy" / ${JSON.stringify(safeName + ".json")}).write_text(json.dumps(concrete, indent=2))
# If a matching file already exists for this model, merge contextLength / gpu
for p in conc_dir.rglob("*.json"):
    if p.name == ${JSON.stringify(safeName + ".json")} or ${JSON.stringify(safeName)} in p.stem:
        try:
            data = json.loads(p.read_text())
        except Exception:
            data = {}
        if isinstance(data, dict):
            data["llm.load.contextLength"] = concrete.get("llm.load.contextLength")
            if "fields" in concrete:
                existing = {f.get("key"): f for f in data.get("fields", []) if isinstance(f, dict)}
                for f in concrete["fields"]:
                    existing[f["key"]] = f
                data["fields"] = list(existing.values())
            p.write_text(json.dumps(data, indent=2))
print("buddy=", buddy_path)
print("concrete_buddy=", conc_dir / "buddy" / ${JSON.stringify(safeName + ".json")})
PY
echo SAVE_OK
echo LOAD_HINT=${bashQuote(loadInfo.cmd)}
`;

  const r = await sshExec(script, 25000, cfg);
  const ok = r.stdout.includes("SAVE_OK") && r.code === 0;

  // Persist locally too (normalize reasoning)
  const reasoningEffort = normalizeReasoningEffort(settings);
  updateConfig({
    control,
    settings: {
      ...settings,
      reasoningEffort,
      thinking: reasoningEffort !== "off",
    },
  });

  return {
    ok,
    modelId,
    loadHint: loadInfo.cmd,
    supported: {
      viaLmsLoad: ["gpu", "context-length", "parallel"],
      viaConcreteBestEffort: ["contextLength", "gpu.offloadRatio", "nParallel"],
      needsWrapper: [
        "ple/n-gram override",
        "lazy-mode",
        "load-mode",
        "kv quant",
        "mmproj",
        "thinking/reasoningEffort (client chat param)",
      ],
    },
    settings: {
      ...control,
      ...settings,
      reasoningEffort: normalizeReasoningEffort(settings),
      thinking: normalizeReasoningEffort(settings) !== "off",
    },
    stdout: r.stdout.trim(),
    stderr: r.stderr.trim(),
    code: r.code,
  };
}

export async function unloadAll(cfg = loadConfig()) {
  const r = await sshExec("lms unload --all -y 2>/dev/null || lms unload --all", 60000, cfg);
  return {
    ok: r.code === 0,
    stdout: r.stdout.trim(),
    stderr: r.stderr.trim(),
    code: r.code,
  };
}

export async function loadModelNow(cfg = loadConfig()) {
  const control = cfg.control || {};
  const settings = cfg.settings || {};
  const { cmd, modelId, ctx, parallel, gpu } = buildLoadArgs(control, settings);

  // Save defaults first so JIT / subsequent loads pick up what we can.
  let saveResult = null;
  try {
    saveResult = await saveModelDefaults(cfg);
  } catch (e) {
    saveResult = { ok: false, error: e.message };
  }

  const r = await sshExec(cmd, 300000, cfg); // loads can take minutes
  const verify = await sshExec(
    "lms ps --json 2>/dev/null || lms ps -j 2>/dev/null || lms ps 2>/dev/null; echo '---CMDLINE---'; pgrep -af 'llm|llama|lms' 2>/dev/null | head -40 || true",
    20000,
    cfg,
  );

  const out = (r.stdout + "\n" + r.stderr).toLowerCase();
  const loadedOk =
    r.code === 0 &&
    !/error|failed|not found/i.test(r.stderr || "") ||
    /loaded|success/i.test(out);

  return {
    ok: Boolean(loadedOk || verify.stdout.includes(modelId)),
    modelId,
    applied: { ctx, parallel, gpu },
    cmd,
    saveResult,
    load: { stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.code },
    verify: { stdout: verify.stdout.trim(), stderr: verify.stderr.trim() },
  };
}

/**
 * Safe GPU power ceiling via nvidia-smi -pl (needs sudo on SER).
 * Always clamps to the card's reported min/max — never above max or below min.
 */
export async function setGpuPowerLimit(
  { index, watts, enablePersistence = true } = {},
  cfg = loadConfig(),
) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) {
    return { ok: false, error: "index must be a non-negative integer" };
  }

  const q = await sshExec(
    `nvidia-smi -i ${idx} --query-gpu=name,power.limit,power.default_limit,power.min_limit,power.max_limit,power.draw --format=csv,noheader,nounits 2>/dev/null`,
    15000,
    cfg,
  );
  if (q.code !== 0 || !q.stdout.trim()) {
    return {
      ok: false,
      error: "Could not read GPU power limits",
      stderr: q.stderr.trim(),
    };
  }
  const parts = q.stdout.trim().split(",").map((p) => p.trim());
  const [name, curLim, defLim, minLim, maxLim, draw] = parts;
  const minW = Number(minLim);
  const maxW = Number(maxLim);
  const defW = Number(defLim);
  let want = Number(watts);
  if (!Number.isFinite(want)) {
    return { ok: false, error: "watts must be a number" };
  }
  if (!Number.isFinite(minW) || !Number.isFinite(maxW)) {
    return { ok: false, error: "GPU did not report min/max power limits" };
  }
  // Clamp hard to NVIDIA-reported range (safe).
  want = Math.round(Math.max(minW, Math.min(maxW, want)));

  const sudoPass = cfg.sshPassword || "";
  const sudoPrefix = sudoPass
    ? `echo ${bashQuote(sudoPass)} | sudo -S -p '' `
    : "sudo -n ";

  const cmds = [];
  if (enablePersistence) {
    cmds.push(`${sudoPrefix}nvidia-smi -i ${idx} -pm 1`);
  }
  cmds.push(`${sudoPrefix}nvidia-smi -i ${idx} -pl ${want}`);
  cmds.push(
    `nvidia-smi -i ${idx} --query-gpu=power.limit,power.draw --format=csv,noheader,nounits`,
  );

  const r = await sshExec(cmds.join(" && "), 30000, cfg);
  const verifyLine = (r.stdout || "").trim().split(/\r?\n/).pop() || "";
  const [newLim, newDraw] = verifyLine.split(",").map((p) => Number(String(p).trim()));
  const applied =
    Number.isFinite(newLim) && Math.abs(newLim - want) < 1.5;

  // Remember preferred limits locally
  const power = { ...(cfg.power || {}), limits: { ...(cfg.power?.limits || {}) } };
  power.limits[String(idx)] = want;
  updateConfig({ power });

  return {
    ok: applied && r.code === 0,
    index: idx,
    name,
    requested: Number(watts),
    applied: want,
    previousLimitW: Number(curLim) || null,
    defaultLimitW: Number.isFinite(defW) ? defW : null,
    minW,
    maxW,
    powerLimitW: Number.isFinite(newLim) ? newLim : null,
    powerDrawW: Number.isFinite(newDraw) ? newDraw : Number(draw) || null,
    stdout: r.stdout.trim(),
    stderr: r.stderr.trim(),
    code: r.code,
    note: applied
      ? "Power limit set within NVIDIA min/max. Resets on full driver reload/reboot unless persistence sticks."
      : "Failed — needs passwordless sudo for nvidia-smi, or SSH password in Connection for sudo -S.",
  };
}

/** Suggested safe presets from card min/default/max. */
export function powerPresets({ powerMinW, powerDefaultW, powerMaxW, name }) {
  const min = Number(powerMinW) || 100;
  const def = Number(powerDefaultW) || min;
  const max = Number(powerMaxW) || def;
  const span = max - min;
  const eco = Math.round(min + span * 0.2);
  const long = Math.round(min + span * 0.45); // long-job quiet
  return {
    eco: Math.max(min, Math.min(max, eco)),
    longJob: Math.max(min, Math.min(max, long)),
    default: Math.max(min, Math.min(max, def)),
    boost: Math.max(min, Math.min(max, max)),
    label: name || "GPU",
  };
}

export async function listRemoteModels(cfg = loadConfig()) {
  const r = await sshExec(
    "lms ls --json 2>/dev/null || lms ls -j 2>/dev/null || lms ls 2>/dev/null",
    30000,
    cfg,
  );
  const models = [];
  try {
    const j = JSON.parse(r.stdout.trim());
    const arr = Array.isArray(j) ? j : j?.models || [];
    for (const m of arr) {
      models.push({
        id: m.modelKey || m.path || m.id,
        label: m.displayName || m.modelKey || m.path,
      });
    }
  } catch {
    for (const line of r.stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || /^(MODEL|IDENTIFIER|─|-)/i.test(t)) continue;
      const id = t.split(/\s+/)[0];
      if (id) models.push({ id, label: t });
    }
  }
  return { ok: r.code === 0, models, raw: r.stdout.trim() };
}

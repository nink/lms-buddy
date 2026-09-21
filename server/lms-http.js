import { loadConfig } from "./config.js";

function baseUrl(cfg) {
  const host = cfg.host.replace(/^https?:\/\//, "");
  return `http://${host}:${Number(cfg.port) || 1234}`;
}

function headers(cfg) {
  const h = { Accept: "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function fetchJson(url, cfg, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: headers(cfg),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

/** Lightweight list for health/metrics (OpenAI-compatible). */
export async function listModels(cfg = loadConfig()) {
  const r = await fetchJson(`${baseUrl(cfg)}/v1/models`, cfg);
  if (!r.ok) {
    return { ok: false, status: r.status, models: [], error: r.text?.slice(0, 200) };
  }
  const models = (r.json?.data || []).map((m) => ({
    id: m.id,
    object: m.object,
    owned_by: m.owned_by,
  }));
  return { ok: true, status: r.status, models };
}

/**
 * Rich catalog from LMS /api/v0/models — includes max_context_length,
 * type (llm/vlm), capabilities (e.g. tool_use), quant, arch.
 */
export async function listModelsDetailed(cfg = loadConfig()) {
  const r = await fetchJson(`${baseUrl(cfg)}/api/v0/models`, cfg, 10000);
  if (!r.ok || !r.json?.data) {
    // Fall back to thin /v1/models
    const thin = await listModels(cfg);
    return {
      ...thin,
      source: thin.ok ? "v1" : "none",
      error: thin.ok ? undefined : r.text?.slice(0, 200) || thin.error,
    };
  }
  const models = (r.json.data || [])
    .filter((m) => m && m.id && (m.type === "llm" || m.type === "vlm" || !m.type))
    .map((m) => ({
      id: m.id,
      type: m.type || "llm",
      publisher: m.publisher || null,
      arch: m.arch || null,
      quantization: m.quantization || null,
      state: m.state || null,
      maxContextLength: Number(m.max_context_length) || null,
      loadedContextLength: Number(m.loaded_context_length) || null,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      compatibilityType: m.compatibility_type || null,
    }));
  return { ok: true, status: r.status, models, source: "v0" };
}

export async function healthCheck(cfg = loadConfig()) {
  // LMS does not always expose /health; try a few endpoints.
  const urls = [
    `${baseUrl(cfg)}/v1/models`,
    `${baseUrl(cfg)}/`,
  ];
  for (const url of urls) {
    try {
      const r = await fetchJson(url, cfg, 4000);
      if (r.status && r.status < 500) {
        return { ok: r.ok || r.status === 200, status: r.status, url };
      }
    } catch {
      /* try next */
    }
  }
  return { ok: false, status: 0, error: "unreachable" };
}

export { baseUrl };

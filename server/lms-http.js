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

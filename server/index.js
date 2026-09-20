import express from "express";
import open from "open";
import path from "node:path";
import { ROOT, loadConfig, updateConfig, publicConfig } from "./config.js";
import { collectMetrics, testConnection } from "./monitor.js";
import {
  saveModelDefaults,
  unloadAll,
  loadModelNow,
  listRemoteModels,
} from "./actions.js";

const PORT = Number(process.env.PORT) || 3847;
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/config", (_req, res) => {
  res.json(publicConfig());
});

app.put("/api/config", (req, res) => {
  const body = req.body || {};
  const current = loadConfig();
  const patch = {};

  for (const k of [
    "host",
    "port",
    "sshUser",
    "sshKeyPath",
    "sshPort",
    "pollMs",
  ]) {
    if (body[k] !== undefined) patch[k] = body[k];
  }

  // Only overwrite secrets when the client sends a non-empty value,
  // or explicitly clears with null.
  if (body.apiKey === null) patch.apiKey = "";
  else if (typeof body.apiKey === "string" && body.apiKey.length) {
    patch.apiKey = body.apiKey;
  }

  if (body.sshPassword === null) patch.sshPassword = "";
  else if (typeof body.sshPassword === "string" && body.sshPassword.length) {
    patch.sshPassword = body.sshPassword;
  }

  if (body.control) patch.control = { ...current.control, ...body.control };
  if (body.settings) patch.settings = { ...current.settings, ...body.settings };

  const saved = updateConfig(patch);
  res.json({ ok: true, config: publicConfig(saved) });
});

app.post("/api/test-connection", async (req, res) => {
  try {
    // Optional one-shot credentials without persisting
    let cfg = loadConfig();
    if (req.body && Object.keys(req.body).length) {
      cfg = {
        ...cfg,
        ...pickConn(req.body),
        apiKey: req.body.apiKey || cfg.apiKey,
        sshPassword: req.body.sshPassword || cfg.sshPassword,
      };
    }
    const result = await testConnection(cfg);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/metrics", async (_req, res) => {
  try {
    const m = await collectMetrics();
    res.json(m);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, gpus: [], errors: [e.message] });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const r = await listRemoteModels();
    res.json(r);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, models: [] });
  }
});

app.post("/api/save-settings", async (req, res) => {
  try {
    if (req.body?.control || req.body?.settings) {
      updateConfig({
        control: req.body.control,
        settings: req.body.settings,
      });
    }
    const result = await saveModelDefaults(loadConfig());
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/unload-all", async (_req, res) => {
  try {
    const result = await unloadAll();
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/load-now", async (req, res) => {
  try {
    if (req.body?.control || req.body?.settings) {
      updateConfig({
        control: req.body.control,
        settings: req.body.settings,
      });
    }
    const result = await loadModelNow(loadConfig());
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function pickConn(body) {
  const o = {};
  for (const k of ["host", "port", "sshUser", "sshKeyPath", "sshPort"]) {
    if (body[k] !== undefined) o[k] = body[k];
  }
  return o;
}

app.listen(PORT, "127.0.0.1", async () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`LMS Buddy → ${url}`);
  if (process.env.LMS_BUDDY_NO_OPEN !== "1") {
    try {
      await open(url);
    } catch {
      /* headless ok */
    }
  }
});

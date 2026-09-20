import express from "express";
import open from "open";
import path from "node:path";
import {
  getPaths,
  loadConfig,
  updateConfig,
  publicConfig,
} from "./config.js";
import { collectMetrics, testConnection } from "./monitor.js";
import {
  saveModelDefaults,
  unloadAll,
  loadModelNow,
  listRemoteModels,
} from "./actions.js";

function pickConn(body) {
  const o = {};
  for (const k of ["host", "port", "sshUser", "sshKeyPath", "sshPort"]) {
    if (body[k] !== undefined) o[k] = body[k];
  }
  return o;
}

export function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    const pub = path.join(getPaths().ROOT, "public");
    express.static(pub, { index: ["index.html"] })(req, res, next);
  });

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
      res
        .status(500)
        .json({ ok: false, error: e.message, gpus: [], errors: [e.message] });
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

  return app;
}

/**
 * @param {{ port?: number, openBrowser?: boolean, host?: string }} opts
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string }>}
 */
export function startServer(opts = {}) {
  const preferred = Number(opts.port ?? process.env.PORT) || 3847;
  const openBrowser =
    opts.openBrowser ?? process.env.LMS_BUDDY_NO_OPEN !== "1";
  const host = opts.host || "127.0.0.1";
  const app = createApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(preferred, host, async () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      const url = `http://${host}:${port}`;
      console.log(`LMS Buddy → ${url}`);
      if (openBrowser) {
        try {
          await open(url);
        } catch {
          /* ok */
        }
      }
      resolve({ server, port, url });
    });
    server.on("error", (err) => {
      if (err && err.code === "EADDRINUSE" && !opts.port) {
        // Retry on ephemeral port
        const retry = app.listen(0, host, async () => {
          const addr = retry.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          const url = `http://${host}:${port}`;
          console.log(`LMS Buddy → ${url} (port busy, using free port)`);
          if (openBrowser) {
            try {
              await open(url);
            } catch {
              /* ok */
            }
          }
          resolve({ server: retry, port, url });
        });
        retry.on("error", reject);
      } else {
        reject(err);
      }
    });
  });
}

// CLI entry when run as `node server/index.js`
const isDirect =
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\\/g, "/").endsWith("/server/index.js");

if (isDirect) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

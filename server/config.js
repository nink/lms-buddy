import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** App install root (public/, package). Overridable for Electron. */
export let ROOT = process.env.LMS_BUDDY_ROOT
  ? path.resolve(process.env.LMS_BUDDY_ROOT)
  : path.resolve(__dirname, "..");

/** Writable config dir. Overridable for Electron userData. */
export let DATA_DIR = process.env.LMS_BUDDY_DATA_DIR
  ? path.resolve(process.env.LMS_BUDDY_DATA_DIR)
  : path.join(ROOT, "data");

export let CONFIG_PATH = path.join(DATA_DIR, "config.json");

export function setPaths({ root, dataDir } = {}) {
  if (root) ROOT = path.resolve(root);
  if (dataDir) DATA_DIR = path.resolve(dataDir);
  CONFIG_PATH = path.join(DATA_DIR, "config.json");
}

export function getPaths() {
  return { ROOT, DATA_DIR, CONFIG_PATH };
}

const DEFAULTS = {
  host: "192.168.72.70",
  port: 1234,
  apiKey: "",
  sshUser: "nink",
  sshPassword: "",
  sshKeyPath: "",
  sshPort: 22,
  pollMs: 2000,
  control: {
    modelId: "ud",
    context: 32768,
    gpu: "max",
    parallel: 1,
  },
  settings: {
    pleCpu: true,
    lazyMode: "off",
    loadMode: "dio",
    nCpuMoe: 0,
    gpuLayers: "all",
    kvQuant: "q8_0",
    mmproj: true,
    thinking: false,
  },
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULTS);
    return structuredClone(DEFAULTS);
  }
  try {
    const text = fs
      .readFileSync(CONFIG_PATH, "utf8")
      .replace(/^\uFEFF/, "");
    const raw = JSON.parse(text);
    return {
      ...structuredClone(DEFAULTS),
      ...raw,
      control: { ...DEFAULTS.control, ...(raw.control || {}) },
      settings: { ...DEFAULTS.settings, ...(raw.settings || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveConfig(cfg) {
  ensureDataDir();
  const merged = {
    ...structuredClone(DEFAULTS),
    ...cfg,
    control: { ...DEFAULTS.control, ...(cfg.control || {}) },
    settings: { ...DEFAULTS.settings, ...(cfg.settings || {}) },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

export function updateConfig(patch) {
  const current = loadConfig();
  const next = {
    ...current,
    ...patch,
    control: { ...current.control, ...(patch.control || {}) },
    settings: { ...current.settings, ...(patch.settings || {}) },
  };
  return saveConfig(next);
}

export function publicConfig(cfg = loadConfig()) {
  return {
    host: cfg.host,
    port: cfg.port,
    apiKeySet: Boolean(cfg.apiKey),
    sshUser: cfg.sshUser,
    sshPasswordSet: Boolean(cfg.sshPassword),
    sshKeyPath: cfg.sshKeyPath || "",
    sshPort: cfg.sshPort,
    pollMs: cfg.pollMs,
    control: cfg.control,
    settings: cfg.settings,
  };
}

export { DEFAULTS };

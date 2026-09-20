import { writeFileSync } from "node:fs";

const BASE = "http://127.0.0.1:3847";
const log = [];

function note(title, data) {
  const line = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  console.log("\n=== " + title + " ===\n" + line);
  log.push({ title, data });
}

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 500)}`);
  return json;
}

const metrics1 = await api("/api/metrics");
note("BEFORE unload metrics", {
  state: metrics1.state,
  model: metrics1.model,
  loaded: metrics1.loaded,
  gpus: metrics1.gpus?.map((g) => ({
    i: g.index,
    name: g.name,
    full: g.fullName,
    temp: g.tempC,
    util: g.utilPct,
    vram: `${g.vramUsedMiB}/${g.vramTotalMiB}`,
  })),
  ram: metrics1.ram,
  cpu: metrics1.cpuPct,
});

note("UNLOAD ALL", await api("/api/unload-all", { method: "POST", body: "{}" }));

await new Promise((r) => setTimeout(r, 2500));
const afterUnload = await api("/api/metrics");
note("AFTER unload", {
  state: afterUnload.state,
  model: afterUnload.model,
  loaded: afterUnload.loaded,
});

note(
  "SAVE SETTINGS",
  await api("/api/save-settings", {
    method: "POST",
    body: JSON.stringify({
      control: { modelId: "ud", context: 32768, gpu: "max", parallel: 1 },
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
    }),
  }),
);

console.log("\n=== LOAD NOW (may take several minutes) ===");
const t0 = Date.now();
const load = await api("/api/load-now", {
  method: "POST",
  body: JSON.stringify({
    control: { modelId: "ud", context: 32768, gpu: "max", parallel: 1 },
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
  }),
});
note("LOAD RESULT", {
  ok: load.ok,
  modelId: load.modelId,
  applied: load.applied,
  cmd: load.cmd,
  ms: Date.now() - t0,
  loadStdout: load.load?.stdout?.slice(0, 1500),
  loadStderr: load.load?.stderr?.slice(0, 800),
  loadCode: load.load?.code,
  verifyHead: load.verify?.stdout?.slice(0, 2500),
});

await new Promise((r) => setTimeout(r, 2000));
const afterLoad = await api("/api/metrics");
note("AFTER load metrics", {
  state: afterLoad.state,
  model: afterLoad.model,
  loaded: afterLoad.loaded,
  gpus: afterLoad.gpus?.map((g) => ({
    i: g.index,
    name: g.name,
    temp: g.tempC,
    util: g.utilPct,
    vram: `${g.vramUsedMiB}/${g.vramTotalMiB}`,
  })),
});

// Assertions summary
const asserts = {
  gpusFound: metrics1.gpus?.length === 3,
  gpuNames: metrics1.gpus?.map((g) => g.fullName),
  unloadCleared: (afterUnload.loaded?.length || 0) === 0,
  loadOk: Boolean(load.ok),
  modelIsUd: afterLoad.model?.id === "ud" || afterLoad.loaded?.[0]?.id === "ud",
  ctx32k: afterLoad.loaded?.[0]?.contextLength === 32768,
  appliedFlags: load.applied,
};
note("ASSERTIONS", asserts);

writeFileSync("data/ser-test-report.json", JSON.stringify({ log, asserts }, null, 2));
console.log("\nWrote data/ser-test-report.json");
process.exit(asserts.loadOk && asserts.modelIsUd ? 0 : 1);

# LMS Buddy

Compact local utility for **monitoring** and **configuring** [LM Studio](https://lmstudio.ai) on a remote host (your LAN box, a lab GPU server, etc.).

~400px corner-sized UI. Runs on your machine; talks to the LMS OpenAI-compatible HTTP API and uses SSH for `lms` CLI + `nvidia-smi`.

## Quick start

```bash
git clone https://github.com/nink/lms-buddy.git
cd lms-buddy
npm install
npm start
```

Opens `http://127.0.0.1:3847` in your browser (Windows-friendly). Set `LMS_BUDDY_NO_OPEN=1` to skip the browser launch.

## Tabs

| Tab | Purpose |
|-----|---------|
| **Monitor** (default) | Live metrics only — model, state, CPU, RAM, per-GPU temp/util/VRAM. UI collapses to monitor height. |
| **Control** | Model id, context, GPU offload, parallel. **Save settings**, **Unload all**, **Load now**. |
| **Settings** | PLE/n-gram, lazy-mode, load-mode, n-cpu-moe, KV quant, mmproj, thinking — with **?** tips. |
| **Connection** | Host, LMS port (default `1234`), optional API key, SSH user / password / key path. |

## What Save / Load write

**Reliably applied via `lms load` (Load now):**

- `--gpu` (`max` / `off` / ratio)
- `--context-length`
- `--parallel`

**Also written best-effort** into:

- `~/.lms-buddy/<model>.json` on the remote host (full buddy sidecar including PLE/lazy/etc.)
- `~/.lmstudio/.internal/user-concrete-model-default-config/buddy/<model>.json`

**Often need a llama-server / custom wrapper** (documented in the sidecar `notes`):

- PLE / n-gram → CPU (`--override-tensor`)
- lazy-mode / load-mode (`dio` / `mmap` / `mlock`)
- KV cache quant, mmproj path, thinking toggle

**Known LMS caveat:** Just-in-time (JIT) loads via the OpenAI API have historically ignored some per-model defaults. Prefer **Load now** (or preload with `lms load`) when you need guarantees.

## Unload all

Runs `lms unload --all` over SSH. Useful when a client’s eject is unreliable.

## Security

- Connection secrets are stored only in local **`data/config.json`** (gitignored).
- Prefer an SSH **private key** over a password when you can.
- Do not commit `.env`, `data/`, or any file containing host passwords.
- See `.env.example` for field names only.

## Architecture

```
npm start  →  Express on 127.0.0.1:3847
               ├─ static SPA (public/)
               ├─ HTTP → remote LMS :port  (/v1/models, …)
               └─ SSH  → lms ps / load / unload, nvidia-smi, config writes
```

Stack: Node.js 18+, Express, `ssh2`. Optional Electron shell can wrap this later; browser is enough for day-to-day use.

## Example (SER-style)

- Host `192.168.72.70`, LMS port `1234`, SSH user `nink`
- Model identifier `ud` (Flash-Next), context `32768`, GPU `max`, parallel `1`

## License

MIT

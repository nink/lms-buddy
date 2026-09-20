# LMS Buddy

Compact **desktop** utility for monitoring and configuring [LM Studio](https://lmstudio.ai) on a remote host.

Double-click **LMS Buddy.exe** — no Node/npm needed for day-to-day use.

## Download / run (Windows)

1. Grab the latest **portable** build from [Releases](https://github.com/nink/lms-buddy/releases), **or** build once (below).
2. Double-click `LMS-Buddy-*-portable.exe`.
3. A small corner window opens. Use **Connection** once to set host / SSH.

Settings are stored under your Windows user profile (`%APPDATA%\lms-buddy\`), not next to the exe.

### Build a clickable exe (developers)

```bash
git clone https://github.com/nink/lms-buddy.git
cd lms-buddy
npm install
npm run dist
```

Output: `dist/LMS-Buddy-<version>-portable.exe` — copy to Desktop and double-click.

Optional: `npm start` runs the Electron window without packaging.  
`npm run start:web` serves the UI in a browser (`http://127.0.0.1:3847`) for debugging.

## Tabs

| Tab | Purpose |
|-----|---------|
| **Monitor** (default) | Live metrics only — model, state, CPU, RAM, per-GPU temp/util/VRAM. |
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

- Connection secrets stay in local app data (gitignored `data/` when using web mode).
- Prefer an SSH **private key** over a password when you can.
- Do not commit passwords or `data/config.json`.

## Architecture

```
LMS Buddy.exe  →  Electron window
                    └─ local Express on 127.0.0.1
                         ├─ HTTP → remote LMS :port
                         └─ SSH  → lms / nvidia-smi
```

## Example (SER-style)

- Host `192.168.72.70`, LMS port `1234`, SSH user `nink`
- Model identifier `ud` (Flash-Next), context `32768`, GPU `max`, parallel `1`

## License

MIT

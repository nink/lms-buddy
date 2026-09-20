import { Client } from "ssh2";
import fs from "node:fs";
import { loadConfig } from "./config.js";

function connectOptions(cfg) {
  const opts = {
    host: cfg.host,
    port: Number(cfg.sshPort) || 22,
    username: cfg.sshUser,
    readyTimeout: 12000,
    tryKeyboard: true,
  };
  if (cfg.sshKeyPath && fs.existsSync(cfg.sshKeyPath)) {
    opts.privateKey = fs.readFileSync(cfg.sshKeyPath);
  } else if (cfg.sshPassword) {
    opts.password = cfg.sshPassword;
  } else {
    throw new Error("SSH auth missing: set password or key path in Connection");
  }
  return opts;
}

/**
 * Run a remote command over SSH. Returns { stdout, stderr, code }.
 * Prepends ~/.lmstudio/bin so `lms` works in non-interactive shells.
 */
export function sshExec(command, timeoutMs = 30000, cfg = loadConfig()) {
  const wrapped = `export PATH="$HOME/.lmstudio/bin:$PATH"; ${command}`;
  return new Promise((resolve, reject) => {
    let opts;
    try {
      opts = connectOptions(cfg);
    } catch (err) {
      reject(err);
      return;
    }

    const conn = new Client();
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      conn.end();
      reject(new Error(`SSH timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    conn
      .on("ready", () => {
        conn.exec(wrapped, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            settled = true;
            conn.end();
            reject(err);
            return;
          }
          let stdout = "";
          let stderr = "";
          stream
            .on("close", (code) => {
              clearTimeout(timer);
              if (settled) return;
              settled = true;
              conn.end();
              resolve({ stdout, stderr, code: code ?? 0 });
            })
            .on("data", (d) => {
              stdout += d.toString();
            });
          stream.stderr.on("data", (d) => {
            stderr += d.toString();
          });
        });
      })
      .on("error", (err) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(err);
      })
      .connect(opts);
  });
}

export async function sshTest(cfg = loadConfig()) {
  const r = await sshExec("echo lms-buddy-ok && whoami && hostname", 10000, cfg);
  return {
    ok: r.code === 0 && r.stdout.includes("lms-buddy-ok"),
    stdout: r.stdout.trim(),
    stderr: r.stderr.trim(),
    code: r.code,
  };
}

/** Escape a string for single-quoted bash. */
export function bashQuote(s) {
  return `'${String(s).replace(/'/g, `'\"'\"'`)}'`;
}

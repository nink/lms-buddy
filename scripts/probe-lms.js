import { sshExec } from "../server/ssh.js";
import { loadConfig } from "../server/config.js";

const cfg = loadConfig();
const cmds = [
  "echo PATH=$PATH",
  "ls -la ~/.lmstudio/bin 2>/dev/null | head -20",
  "ls -la ~/.lmstudio 2>/dev/null | head -40",
  "find /home/nink -name 'lms' 2>/dev/null | head -20",
  "ls /home/nink/.local/bin 2>/dev/null | head -20",
  "grep -n lms /home/nink/.bashrc /home/nink/.profile 2>/dev/null | head -30",
  "bash -lc 'which lms; lms --version' 2>&1 | head -20",
  "source ~/.bashrc 2>/dev/null; which lms; type lms 2>&1 | head -10",
];

for (const cmd of cmds) {
  console.log("====", cmd);
  const r = await sshExec(cmd, 45000, cfg);
  console.log((r.stdout || "(empty)").slice(0, 2000));
  if (r.stderr) console.log("ERR", r.stderr.slice(0, 500));
}

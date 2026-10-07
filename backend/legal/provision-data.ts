import { spawnSync } from "node:child_process";
import path from "node:path";
import { env } from "../src/config/env.js";

const script = path.join("backend", "legal", "provision_data.py");
const result = spawnSync(env.legal.python, [script], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exitCode = result.status ?? 1;

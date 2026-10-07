import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("LEGAL_RAG_ROOT selects the existing MCP runtime and its read-only data folder", async () => {
  const ragRoot = await mkdtemp(path.join(os.tmpdir(), "workfolio-legal-runtime-"));
  const pythonRelative = process.platform === "win32"
    ? path.join(".mcp-venv", "Scripts", "python.exe")
    : path.join(".mcp-venv", "bin", "python");
  const pythonPath = path.join(ragRoot, pythonRelative);
  const scriptPath = path.join(ragRoot, "rag_mcp_server.py");
  await mkdir(path.dirname(pythonPath), { recursive: true });
  await mkdir(path.join(ragRoot, "data"), { recursive: true });
  await writeFile(pythonPath, "test interpreter placeholder");
  await writeFile(scriptPath, "# test runtime placeholder");

  try {
    const envModule = fileURLToPath(import.meta.resolve("../src/config/env.ts"));
    const tsxLoader = import.meta.resolve("tsx");
    const code = `const { env } = await import(${JSON.stringify(pathToFileURL(envModule).href)}); process.stdout.write(JSON.stringify({ root: env.legal.root, runtimeRoot: env.legal.runtimeRoot, python: env.legal.python, script: env.legal.script }));`;
    const child = spawnSync(process.execPath, ["--import", tsxLoader, "--eval", code], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        LEGAL_RAG_ROOT: ragRoot,
      },
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), {
      root: path.join(ragRoot, "data"),
      runtimeRoot: ragRoot,
      python: pythonPath,
      script: scriptPath,
    });
  } finally {
    await rm(ragRoot, { recursive: true, force: true });
  }
});

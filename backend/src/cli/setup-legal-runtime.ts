import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const legalRoot = path.join(repositoryRoot, "backend", "legal");
const environmentRoot = path.join(legalRoot, ".venv");
const python = path.join(
  environmentRoot,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
const requirements = path.join(legalRoot, "requirements.txt");

function run(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    console.error(`실행할 수 없습니다: ${command} (${result.error.message})`);
    return false;
  }
  return result.status === 0;
}

function findSystemPython(): { command: string; args: string[] } | undefined {
  const candidates =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3"] },
          { command: "python", args: [] },
        ]
      : [
          { command: "python3", args: [] },
          { command: "python", args: [] },
        ];
  return candidates.find(({ command, args }) => {
    const result = spawnSync(command, [...args, "--version"], {
      cwd: repositoryRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    return !result.error && result.status === 0;
  });
}

function main(): void {
  const option = process.argv[2];
  if (option === "--help") {
    console.log(
      "Usage: npm run setup:legal [--check]\n\nCreates backend/legal/.venv and installs backend/legal/requirements.txt.\nDoes not download corpus data, edit .env, or modify an external LEGAL_RAG_ROOT.",
    );
    return;
  }

  if (!existsSync(requirements)) {
    console.error(`법률 런타임 요구사항 파일이 없습니다: ${requirements}`);
    process.exitCode = 1;
    return;
  }

  if (option === "--check") {
    if (!existsSync(python)) {
      console.error(
        "로컬 법률 Python 환경이 없습니다. npm run setup:legal을 실행하세요.",
      );
      process.exitCode = 1;
      return;
    }
    console.log("로컬 법률 Python 환경이 준비되어 있습니다.");
    return;
  }

  if (option) {
    console.error(`지원하지 않는 옵션입니다: ${option}`);
    process.exitCode = 2;
    return;
  }

  const systemPython = findSystemPython();
  if (!systemPython) {
    console.error(
      "Python 3를 찾지 못했습니다. Python 3 설치 후 다시 실행하세요.",
    );
    process.exitCode = 1;
    return;
  }

  if (!existsSync(python)) {
    console.log(`저장소 전용 Python 환경 생성: ${path.relative(repositoryRoot, environmentRoot)}`);
    if (!run(systemPython.command, [...systemPython.args, "-m", "venv", environmentRoot])) {
      process.exitCode = 1;
      return;
    }
  }

  console.log("법률 검색용 Python 패키지를 설치합니다.");
  if (!run(python, ["-m", "pip", "install", "-r", requirements])) {
    process.exitCode = 1;
    return;
  }
  console.log(
    "법률 Python 환경이 준비되었습니다. 코퍼스 파일을 받으려면 별도로 npm run legal:data를 실행하세요.",
  );
}

main();

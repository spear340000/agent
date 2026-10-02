import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { LegalRetrievalError } from "../../domain/legal-error.js";

export type McpClientOptions = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  maxResponseCharacters: number;
  restartBudget: number;
  stderrTailCharacters: number;
};

export type McpToolResult = { text: string; isError: boolean };
export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema?: unknown;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
  detach: () => void;
};

const CLIENT_INFO = { name: "workfolio-legal", version: "0.1.0" };
const PROTOCOL_VERSION = "2024-11-05";

export class McpStdioClient {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private started = false;
  private restartsUsed = 0;
  private closed = false;
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly options: McpClientOptions) {
    if (!options.command.trim()) throw new Error("mcp command is required");
    if (!options.cwd.trim()) throw new Error("mcp cwd is required");
    if (
      !Number.isSafeInteger(options.startupTimeoutMs) ||
      options.startupTimeoutMs < 1
    )
      throw new Error("startupTimeoutMs must be a positive integer");
    if (
      !Number.isSafeInteger(options.requestTimeoutMs) ||
      options.requestTimeoutMs < 1
    )
      throw new Error("requestTimeoutMs must be a positive integer");
    if (
      !Number.isSafeInteger(options.maxResponseCharacters) ||
      options.maxResponseCharacters < 1
    )
      throw new Error("maxResponseCharacters must be a positive integer");
    if (
      !Number.isSafeInteger(options.restartBudget) ||
      options.restartBudget < 0
    )
      throw new Error("restartBudget must be a non-negative integer");
  }

  get running(): boolean {
    const child = this.child;
    return Boolean(child) && child!.exitCode === null && !child!.killed;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const result = await this.request<{ content?: unknown; isError?: unknown }>(
      "tools/call",
      { name, arguments: args },
      signal,
    );
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new LegalRetrievalError(
        "malformed",
        `${name} returned an invalid result envelope`,
      );
    }
    const blocks = Array.isArray(result.content) ? result.content : null;
    if (!blocks)
      throw new LegalRetrievalError(
        "malformed",
        `${name} returned no content blocks`,
      );
    const text = blocks
      .map((block) => {
        if (!block || typeof block !== "object" || Array.isArray(block))
          return "";
        const candidate = block as { type?: unknown; text?: unknown };
        return candidate.type === "text" && typeof candidate.text === "string"
          ? candidate.text
          : "";
      })
      .filter(Boolean)
      .join("\n");
    if (!text.trim())
      throw new LegalRetrievalError(
        "malformed",
        `${name} returned an empty text result`,
      );
    return { text, isError: result.isError === true };
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const result = await this.request<{ tools?: unknown }>(
      "tools/list",
      {},
      signal,
    );
    if (!result || !Array.isArray(result.tools))
      throw new LegalRetrievalError(
        "malformed",
        "tools/list returned an invalid result envelope",
      );
    return result.tools.flatMap((tool): McpToolDescriptor[] => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return [];
      const entry = tool as {
        name?: unknown;
        description?: unknown;
        inputSchema?: unknown;
      };
      if (typeof entry.name !== "string" || !entry.name) return [];
      return [
        {
          name: entry.name,
          description:
            typeof entry.description === "string" ? entry.description : "",
          ...(entry.inputSchema && typeof entry.inputSchema === "object"
            ? { inputSchema: entry.inputSchema }
            : {}),
        },
      ];
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending(
      new LegalRetrievalError("transport", "legal retrieval client closed"),
    );
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    let settled = false;
    let finish: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (child.exitCode === null) child.once("exit", finish);
      else finish();
    });
    child.stdin.end();
    child.kill();
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill();
      finish();
    }, 2_000);
    timer.unref();
    await exited;
    clearTimeout(timer);
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }

  private async request<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const child = await this.ensureChild();
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    if (signal?.aborted)
      throw new LegalRetrievalError(
        "transport",
        "legal retrieval was cancelled",
      );
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const detach = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        detach();
        action();
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new LegalRetrievalError(
          "timeout",
          `${method} exceeded ${this.options.requestTimeoutMs}ms`,
        );
        this.failPending(error);
        this.terminate();
        settle(() => reject(error));
      }, this.options.requestTimeoutMs);
      const onAbort = (): void => {
        this.pending.delete(id);
        settle(() =>
          reject(
            new LegalRetrievalError(
              "transport",
              "legal retrieval was cancelled",
            ),
          ),
        );
      };
      this.pending.set(id, {
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
        timer,
        detach,
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.write(line, "utf8", (error) => {
        if (error)
          settle(() =>
            reject(
              new LegalRetrievalError(
                "transport",
                `legal retrieval request could not be written: ${error.message}`,
              ),
            ),
          );
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
      "utf8",
      () => undefined,
    );
  }

  private async ensureChild(): Promise<ChildProcessWithoutNullStreams> {
    if (this.closed)
      throw new LegalRetrievalError(
        "transport",
        "legal retrieval client is closed",
      );
    const existing = this.child;
    if (existing && existing.exitCode === null && !existing.killed)
      return existing;
    if (this.started && this.restartsUsed >= this.options.restartBudget) {
      throw new LegalRetrievalError(
        "transport",
        "legal retrieval process is unavailable after its single restart attempt",
      );
    }
    if (this.started) this.restartsUsed += 1;
    if (!this.startPromise) this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
    const child = this.child;
    if (!child)
      throw new LegalRetrievalError(
        "startup",
        "legal retrieval process did not start",
      );
    return child;
  }

  private async start(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw new LegalRetrievalError(
        "startup",
        error instanceof Error ? error.message : String(error),
      );
    }
    this.started = true;
    this.child = child;
    this.buffer = "";
    this.stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(
        -this.options.stderrTailCharacters,
      );
    });
    child.on("error", (error) => {
      this.child = undefined;
      this.failPending(new LegalRetrievalError("startup", error.message));
    });
    child.on("exit", (code, signal) => {
      this.child = undefined;
      this.failPending(
        new LegalRetrievalError(
          "transport",
          `process exited (code ${code ?? signal ?? "unknown"})${this.stderrNote()}`,
        ),
      );
    });
    child.unref();

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.terminate();
        reject(
          new LegalRetrievalError(
            "startup",
            `handshake exceeded ${this.options.startupTimeoutMs}ms`,
          ),
        );
      }, this.options.startupTimeoutMs);
      const onError = (error: Error): void => {
        cleanup();
        reject(new LegalRetrievalError("startup", error.message));
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(
          new LegalRetrievalError(
            "startup",
            `process exited before the handshake (code ${code ?? "unknown"})${this.stderrNote()}`,
          ),
        );
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("spawn", () => {
        cleanup();
        resolve();
      });
    });

    await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    this.notify("notifications/initialized", {});
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.options.maxResponseCharacters) {
      this.buffer = "";
      this.abort("legal retrieval response exceeded the configured size limit");
      return;
    }
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.abort("legal retrieval returned a non-JSON protocol line");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.abort("legal retrieval returned an invalid protocol message");
      return;
    }
    const record = message as {
      id?: unknown;
      result?: unknown;
      error?: unknown;
    };
    if (typeof record.id !== "number" || !Number.isSafeInteger(record.id))
      return;
    const pending = this.pending.get(record.id);
    if (!pending) return;
    this.pending.delete(record.id);
    if (record.error && typeof record.error === "object") {
      const failure = record.error as { code?: unknown; message?: unknown };
      pending.reject(
        new LegalRetrievalError(
          "protocol",
          `JSON-RPC error ${String(failure.code ?? "unknown")}: ${String(failure.message ?? "no message")}`,
        ),
      );
      return;
    }
    pending.resolve(record.result ?? null);
  }

  private stderrNote(): string {
    const tail = this.stderrTail.trim();
    return tail ? `; stderr: ${tail.slice(-400)}` : "";
  }

  private abort(message: string): void {
    this.failPending(new LegalRetrievalError("malformed", message));
    this.terminate();
  }

  private failPending(error: LegalRetrievalError): void {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const entry of entries) {
      entry.detach();
      entry.reject(error);
    }
  }

  private terminate(): void {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin.destroy();
    child.kill();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

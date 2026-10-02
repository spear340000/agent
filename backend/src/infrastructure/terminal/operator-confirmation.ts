import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { ComputerAction } from '../../tools/computer-use.js';
import type { OperatorConfirmation } from '../../application/operator-confirmation.js';

export interface ConfirmationTerminal {
  readonly isInteractive: boolean;
  ask(prompt: string): Promise<string | null>;
  cancel(): void;
}

export type ConfirmationOptions = { maxPending?: number; timeoutMs?: number };

class ReadlineConfirmationTerminal implements ConfirmationTerminal {
  readonly isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  private active: Interface | undefined;

  ask(prompt: string): Promise<string | null> {
    if (!this.isInteractive) return Promise.resolve(null);
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    this.active = readline;
    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        this.active = undefined;
        readline.close();
        resolve(answer);
      };
      readline.once('close', () => finish(null));
      readline.question(prompt, answer => finish(answer));
    });
  }

  cancel(): void { this.active?.close(); }
}

export class TerminalOperatorConfirmation implements OperatorConfirmation {
  private pending = 0;
  private queueDeadline: number | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly maxPending: number;
  private readonly timeoutMs: number;

  constructor(private readonly terminal: ConfirmationTerminal = new ReadlineConfirmationTerminal(), options: ConfirmationOptions = {}) {
    this.maxPending = options.maxPending ?? 8;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new Error('maxPending must be a positive integer');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error('timeoutMs must be a positive integer');
  }

  confirm(action: ComputerAction): Promise<boolean> {
    if (this.closed || !this.terminal.isInteractive || this.pending >= this.maxPending) return Promise.resolve(false);
    if (this.pending === 0) this.queueDeadline = Date.now() + this.timeoutMs;
    this.pending++;
    const expiresAt = this.queueDeadline!;
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>(resolve => { release = resolve; });
    return previous.then(async () => {
      if (this.closed) return false;
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) return false;
      const answer = await this.askWithTimeout(this.describe(action), remaining);
      return answer?.trim().toLowerCase() === 'yes';
    }).catch(() => false).finally(() => {
      this.pending--;
      if (this.pending === 0) this.queueDeadline = undefined;
      release();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.terminal.cancel();
    await this.queue;
  }

  private askWithTimeout(prompt: string, timeoutMs: number): Promise<string | null> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => { this.terminal.cancel(); finish(null); }, timeoutMs);
      this.terminal.ask(prompt).then(finish, () => finish(null));
    });
  }

  private describe(action: ComputerAction): string {
    const detail = action.kind === 'click' ? `x=${action.x}, y=${action.y}` : action.kind === 'type' ? `text=${JSON.stringify(action.text)}` : 'read-only screenshot';
    return `\n[DESKTOP ACTION] ${action.kind}: ${detail}\nType yes to allow this action (typed text may be sensitive): `;
  }
}

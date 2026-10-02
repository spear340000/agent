import assert from 'node:assert/strict';
import { ComputerControlService } from '../src/application/computer-control-service.ts';
import { TerminalOperatorConfirmation, type ConfirmationTerminal } from '../src/infrastructure/terminal/operator-confirmation.ts';
import type { ComputerAction } from '../src/tools/computer-use.ts';

const executed: ComputerAction[] = [];
let confirmCalls = 0;
let shouldConfirm = true;
let computerAvailable = true;
const computer = { isAvailable: () => computerAvailable, perform: async (action: ComputerAction) => { executed.push(action); return { kind: action.kind, executed: true }; } };
const confirmation = { confirm: async () => { confirmCalls++; return shouldConfirm; } };
const service = new ComputerControlService(computer as never, confirmation);

await service.execute({ kind: 'click', x: 12, y: 34 });
assert.equal(executed.length, 1);
assert.equal(confirmCalls, 1);
shouldConfirm = false;
await assert.rejects(() => service.execute({ kind: 'type', text: 'sensitive text' }), /not approved/);
assert.equal(executed.length, 1);
await service.execute({ kind: 'screenshot' });
assert.equal(executed.length, 2);
assert.equal(confirmCalls, 2);
computerAvailable = false;
await assert.rejects(() => service.execute({ kind: 'click', x: 1, y: 2 }), /not available/);
assert.equal(confirmCalls, 2);

const answers: Array<(answer: string | null) => void> = [];
let askCount = 0;
let closed = false;
const shownPrompts: string[] = [];
const terminal: ConfirmationTerminal = {
  isInteractive: true,
  ask: async prompt => { askCount++; shownPrompts.push(prompt); return new Promise(resolve => answers.push(resolve)); },
  cancel: () => { closed = true; answers.shift()?.(null); },
};
const queued = new TerminalOperatorConfirmation(terminal, { maxPending: 2, timeoutMs: 25 });
const first = queued.confirm({ kind: 'click', x: 1, y: 2 });
const second = queued.confirm({ kind: 'type', text: 'hello' });
const overflow = await queued.confirm({ kind: 'click', x: 3, y: 4 });
assert.equal(overflow, false);
assert.equal(askCount, 1);
assert.match(shownPrompts[0]!, /x=1, y=2/);
answers.shift()?.('yes');
assert.equal(await first, true);
while (askCount < 2) await new Promise(resolve => setImmediate(resolve));
answers.shift()?.('no');
assert.equal(await second, false);
await queued.close();

const stalled = new TerminalOperatorConfirmation({ isInteractive: true, ask: async () => new Promise<string | null>(() => undefined), cancel: () => undefined }, { maxPending: 1, timeoutMs: 5 });
assert.equal(await stalled.confirm({ kind: 'type', text: 'will time out' }), false);
await stalled.close();

let expiredPromptCount = 0;
let resolveExpiredPrompt: ((answer: string | null) => void) | undefined;
const expiringQueue = new TerminalOperatorConfirmation({
  isInteractive: true,
  ask: async () => { expiredPromptCount++; return new Promise(resolve => { resolveExpiredPrompt = resolve; }); },
  cancel: () => resolveExpiredPrompt?.(null),
}, { maxPending: 2, timeoutMs: 5 });
const expiringFirst = expiringQueue.confirm({ kind: 'click', x: 4, y: 5 });
const expiringSecond = expiringQueue.confirm({ kind: 'click', x: 6, y: 7 });
assert.deepEqual(await Promise.all([expiringFirst, expiringSecond]), [false, false]);
assert.equal(expiredPromptCount, 1);
await expiringQueue.close();

const unavailable = new TerminalOperatorConfirmation({ isInteractive: false, ask: async () => 'yes', cancel: () => undefined });
assert.equal(await unavailable.confirm({ kind: 'click', x: 1, y: 2 }), false);
await unavailable.close();
assert.equal(closed, true);

console.log('computer confirmation tests passed');

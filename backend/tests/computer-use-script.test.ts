import assert from 'node:assert/strict';
import { buildComputerPowerShellScript } from '../src/tools/computer-use.ts';

const clickScript = buildComputerPowerShellScript({ kind: 'click', x: 500, y: 300 });
assert.match(clickScript, /PrimaryScreen\.Bounds;if\(500 -ge \$bounds\.Width/);
assert.match(clickScript, /300 -ge \$bounds\.Height/);
assert.match(clickScript, /SetCursorPos\(500,300\)/);
assert.match(clickScript, /throw/);
assert.ok(clickScript.indexOf('SetCursorPos(500,300)') < clickScript.indexOf('mouse_event(2'), 'mouse-down must only run after coordinate movement succeeds');

const sensitiveText = '+^%~(){}\nhello';
const typeScript = buildComputerPowerShellScript({ kind: 'type', text: sensitiveText });
assert.ok(!typeScript.includes(sensitiveText), 'typed data must not be interpolated into the PowerShell source');
assert.ok(typeScript.includes(Buffer.from(sensitiveText).toString('base64')));
assert.match(typeScript, /SendKeys/);
assert.match(typeScript, /\{ENTER\}/);
assert.match(typeScript, /\[\+\^%~\(\)\{\}\]/);

console.log('computer action script tests passed');

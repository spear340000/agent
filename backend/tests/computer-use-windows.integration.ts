import assert from 'node:assert/strict';
import { ComputerUseService } from '../src/tools/computer-use.ts';

if (process.platform !== 'win32' || process.env.COMPUTER_INTEGRATION_TESTS !== 'true'
  || process.env.COMPUTER_TEST_ALLOW_SCREEN_CAPTURE !== 'true' || process.env.COMPUTER_USE_ENABLED !== 'true') {
  console.log('real Windows computer-use integration skipped (requires Windows and explicit screenshot opt-in)');
} else {
  const service = new ComputerUseService();
  const screenshot = await service.perform({ kind: 'screenshot' });
  assert.equal(screenshot.executed, true);
  assert.ok(screenshot.screenshotBase64?.length);
  console.log('real Windows computer-use integration passed (screenshot bytes were not printed)');
}

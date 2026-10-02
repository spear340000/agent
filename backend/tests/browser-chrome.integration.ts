import assert from 'node:assert/strict';
import { BrowserUseService } from '../src/tools/browser-use.ts';
import { env } from '../src/config/env.ts';

const publicUrl = process.env.BROWSER_TEST_PUBLIC_URL;
if (process.env.BROWSER_INTEGRATION_TESTS !== 'true' || !env.browserExecutablePath || !publicUrl) {
  console.log('real Chrome integration skipped (requires BROWSER_INTEGRATION_TESTS=true, BROWSER_EXECUTABLE_PATH, and BROWSER_TEST_PUBLIC_URL)');
} else {
  const service = new BrowserUseService({ maxSessions: 1, findExecutable: () => env.browserExecutablePath });
  try {
    const session = await service.create(publicUrl);
    assert.equal(new URL(session.url).origin, new URL(publicUrl).origin);
    const extracted = await service.perform(session.sessionId, { kind: 'extractText' });
    assert.ok(extracted.text?.trim(), 'configured public test page should expose readable body text');
    await assert.rejects(service.perform(session.sessionId, { kind: 'navigate', url: 'http://127.0.0.1/' }), /private or local/i);
    const redirectProbe = process.env.BROWSER_TEST_PRIVATE_REDIRECT_URL;
    if (redirectProbe) await assert.rejects(service.create(redirectProbe), /net::|blocked|failed|private|local/i);
  } finally {
    await service.closeAll();
  }
  console.log('real Chrome integration passed');
}

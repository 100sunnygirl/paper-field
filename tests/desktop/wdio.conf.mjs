import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.env.PF_E2E_ROOT || !process.env.PF_E2E_BINARY) {
  throw new Error('Run npm run test:desktop, not WDIO directly.');
}
const outputDir = resolve('test-results/desktop', process.env.PF_E2E_PHASE);
export const config = {
  runner: 'local',
  specs: ['./smoke.spec.mjs'],
  maxInstances: 1,
  services: [['@wdio/tauri-service', {
    appBinaryPath: process.env.PF_E2E_BINARY,
    driverProvider: 'embedded',
    startTimeout: 90000,
    statusPollTimeout: 5000,
    captureBackendLogs: false,
    captureFrontendLogs: false,
  }]],
  capabilities: [{ browserName: 'tauri', 'tauri:options': { application: process.env.PF_E2E_BINARY } }],
  framework: 'mocha',
  mochaOpts: { timeout: 90000 },
  logLevel: 'info',
  outputDir,
  waitforTimeout: 20000,
  connectionRetryTimeout: 90000,
  connectionRetryCount: 1,
  specFileRetries: 0,
  async afterTest(_test, _context, { passed }) {
    if (passed) return;
    await mkdir(outputDir, { recursive: true });
    // Preserve the original assertion if a failed webview also prevents capture.
    await browser.saveScreenshot(resolve(outputDir, 'failure.png')).catch(() => {});
    await browser.getPageSource().then(source => writeFile(resolve(outputDir, 'failure.html'), source)).catch(() => {});
  },
};

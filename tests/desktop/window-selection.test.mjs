// Driver-adapter regression test, not a substitute for the native smoke.
import assert from 'node:assert/strict';
import test from 'node:test';
import TauriService from '@wdio/tauri-service';
import { selectNativeWindow } from './window-selection.mjs';

test('explicit native window selection avoids optional plugin focus probes', async () => {
  const service = new TauriService({ driverProvider: 'embedded' }, {});
  let probes = 0;
  const browser = {
    sessionId: 'window-selection-regression',
    async getWindowHandles() { return ['main']; },
    async switchToWindow(handle) {
      assert.equal(handle, 'main');
      await service.afterCommand('switchToWindow', [handle], null, undefined);
    },
    tauri: { async execute() { probes++; throw new Error('No rich plugin installed'); } },
  };
  service.browser = browser;
  await selectNativeWindow(browser);
  for (const command of ['$', 'findElement', 'elementClick', 'getTitle']) {
    await service.beforeCommand(command, []);
  }
  assert.equal(probes, 0);
});

test('unexpected native windows are rejected rather than guessed', async () => {
  await assert.rejects(selectNativeWindow({
    async getWindowHandles() { return ['unexpected']; },
    async switchToWindow() { assert.fail('Must not select an unexpected window'); },
  }), /Expected the native main window/);
});

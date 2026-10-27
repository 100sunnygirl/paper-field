// Harness synchronization checks, not native desktop coverage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { waitForVisibleText } from './ui-waits.mjs';

function driver(elements) {
  let queries = 0;
  return {
    get queries() { return queries; },
    async $(selector) {
      assert.equal(selector, '#paper-title');
      const [visible, text] = elements[Math.min(queries++, elements.length - 1)];
      return { async isDisplayed() { return visible; }, async getText() { return text; } };
    },
    async waitUntil(predicate) {
      for (let i = 0; i < 3; i++) if (await predicate()) return;
      throw new Error('condition not met');
    },
  };
}

test('requeries a detached title until the replacement is visible with correct text', async () => {
  const browser = driver([[false, 'old paper'], [true, 'smoke']]);
  await waitForVisibleText(browser, '#paper-title', 'smoke');
  assert.equal(browser.queries, 2);
});

test('does not accept hidden expected text or a visible wrong paper', async () => {
  for (const state of [[false, 'smoke'], [true, 'old paper']]) {
    await assert.rejects(waitForVisibleText(driver([state]), '#paper-title', 'smoke'), /condition not met/);
  }
});

test('ignores only surrounding rendered whitespace, not content differences', async () => {
  await waitForVisibleText(driver([[true, 'smoke\n']]), '#paper-title', 'smoke');
  await assert.rejects(waitForVisibleText(driver([[true, 'smo ke\n']]), '#paper-title', 'smoke'), /condition not met/);
});

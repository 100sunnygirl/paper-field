import assert from 'node:assert/strict';

const domain = 'Native smoke domain';
const note = 'Native SQLite note survives a complete process restart.';
const phase = process.env.PF_E2E_PHASE;

async function click(selector) {
  const element = await $(selector);
  await element.waitForDisplayed();
  await element.click();
}

async function openPaperList() {
  // Hosted desktop screens can clamp the 1440px window to 1024px. At that
  // width the real navigation lives in a drawer, just as it does for a user.
  if (!(await $('[aria-label^="切换研究领域"]').isDisplayed())) {
    await click('button.ef-list-back');
  }
  await $('[aria-label^="切换研究领域"]').waitForDisplayed();
}

describe(`real Tauri desktop — ${phase}`, () => {
  it('creates or reopens a domain, imported PDF, and persistent note', async () => {
    await $('[aria-label="主导航"]').waitForDisplayed({ timeout: 60000 });
    await openPaperList();
    await click('[aria-label^="切换研究领域"]');
    if (phase === 'create') {
      await click('button=新建领域');
      await $('input[placeholder="多模态"]').setValue(domain);
      await click('button=创建领域');
      await click('button*=添加论文');
      // This native-import button is absent from browser preview.
      await click('button*=选择 PDF');
      await click('button=导入 1');
      // Dismiss the responsive list drawer, not the import dialog: wait for
      // import completion first so Escape cannot conceal a failed import.
      await $('[role="dialog"]').waitForExist({ reverse: true });
      await browser.keys('Escape');
      await $('#paper-title').waitForDisplayed();
      assert.equal(await $('#paper-title').getText(), 'smoke');
      await click('#note-summary .ef-note-start');
      await $('textarea[aria-label="总结内容"]').setValue(note);
      await click('//section[@id="note-summary"]//button[normalize-space(.)="保存笔记"]');
    } else if (phase === 'reopen') {
      await click(`button.ef-domain-option*=${domain}`);
      await openPaperList();
      await click('//div[@aria-label="论文列表"]//button[.//h3[normalize-space(.)="smoke"]]');
      await $('#paper-title').waitForDisplayed();
      assert.equal(await $('#paper-title').getText(), 'smoke');
    } else {
      throw new Error(`Unknown phase: ${phase}`);
    }
    await browser.waitUntil(async () => (await $('#note-summary .ef-note-text').getText()) === note,
      { timeoutMsg: 'Saved note did not appear in the native webview' });
    await openPaperList();
    assert.equal(await $('[aria-label^="切换研究领域"]').getText(), domain);
  });
});

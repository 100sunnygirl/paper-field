export async function waitForVisibleText(browser, selector, expected) {
  await browser.waitUntil(async () => {
    // React can replace the article (key=paper.id) after import/select. The
    // embedded driver returns false for a detached element instead of a stale
    // reference error, so never retain one element across all wait polls.
    const element = await browser.$(selector);
    // Markdown adds a newline after its closing paragraph; embedded WebDriver
    // preserves it in getText(). Ignore surrounding presentation whitespace only.
    return await element.isDisplayed() && (await element.getText()).trim() === expected;
  }, { timeoutMsg: `Expected visible ${selector} with text ${JSON.stringify(expected)}` });
}

export async function selectNativeWindow(browser) {
  const handles = await browser.getWindowHandles();
  if (handles.length !== 1 || handles[0] !== 'main') {
    throw new Error(`Expected the native main window, got ${JSON.stringify(handles)}`);
  }
  // Explicit selection disables WDIO 1.5.1's automatic focus recovery. That
  // optional helper invokes the richer wdio plugin on every element command;
  // this DOM-only smoke deliberately has neither that plugin nor global Tauri.
  await browser.switchToWindow(handles[0]);
}

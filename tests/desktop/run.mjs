import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const binary = resolve(process.env.PF_E2E_BINARY ||
  `src-tauri/target/desktop-e2e/debug/paper-field${process.platform === 'win32' ? '.exe' : ''}`);
await access(binary);
const root = await mkdtemp(join(tmpdir(), 'paper-field-e2e-'));
const results = resolve('test-results/desktop');
await mkdir(results, { recursive: true });
await writeFile(join(root, '.paper-field-e2e'), 'paper-field desktop smoke\n');
await copyFile('tests/desktop/fixtures/smoke.pdf', join(root, 'smoke.pdf'));

function run(command, args, env = process.env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() :
      reject(new Error(`${command} exited ${code ?? signal}`)));
  });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
let previousPid;
try {
  for (const phase of ['create', 'reopen']) {
    await rm(join(root, 'process-id'), { force: true });
    await run(process.execPath, ['node_modules/@wdio/cli/bin/wdio.js', 'run', 'tests/desktop/wdio.conf.mjs'],
      { ...process.env, PF_E2E_ROOT: root, PF_E2E_BINARY: binary, PF_E2E_PHASE: phase });
    const pid = Number((await readFile(join(root, 'process-id'), 'utf8')).trim());
    assert.ok(Number.isInteger(pid) && pid > 0, 'Native startup did not record a PID');
    assert.notEqual(pid, previousPid, 'Restart reused the same native process');
    const deadline = Date.now() + 15000;
    while (alive(pid) && Date.now() < deadline) await delay(100);
    assert.equal(alive(pid), false, 'WDIO teardown left the native process alive');
    previousPid = pid;
    await run('python', ['tests/desktop/verify.py', root]);
  }
  await writeFile(join(results, 'result.json'), JSON.stringify({
    passed: true, phases: ['create', 'reopen'], backend: 'native Tauri / SQLite',
    nativeFilePickerAutomated: false,
  }, null, 2));
} finally {
  // A startup/test failure can precede the service's normal teardown. Only the
  // PID recorded by this run's instrumented app is eligible for cleanup.
  const pid = Number(await readFile(join(root, 'process-id'), 'utf8').catch(() => '0'));
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (alive(pid) && Date.now() < deadline) await delay(100);
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL');
      const killedDeadline = Date.now() + 5000;
      while (alive(pid) && Date.now() < killedDeadline) await delay(100);
    }
    assert.equal(alive(pid), false, 'Refusing to delete the profile while its native process is alive');
  }
  // Only synthetic data from this uniquely-created profile is captured/deleted.
  await cp(root, join(results, 'profile'), { recursive: true }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

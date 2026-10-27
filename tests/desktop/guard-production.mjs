import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Resolve the active default dependency graph, not Cargo.lock (which includes optional crates).
const tree = execFileSync('cargo', ['tree', '--manifest-path', 'src-tauri/Cargo.toml', '--locked',
  '--edges', 'normal,build', '--prefix', 'none'], { encoding: 'utf8' });
assert.doesNotMatch(tree, /tauri-plugin-wdio/, 'WDIO must not enter the production dependency graph');
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(config.identifier, 'com.paperfield.notes');
assert.notEqual(config.app.withGlobalTauri, true);
assert.doesNotMatch(readFileSync('src-tauri/capabilities/default.json', 'utf8'), /wdio/);
console.log('Production defaults exclude native test instrumentation');

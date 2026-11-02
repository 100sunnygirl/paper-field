# Native desktop smoke

Runs the actual Tauri binary, bundled React frontend, Rust commands, SQLite and
filesystem on Windows x64, macOS ARM64 and macOS Intel. This is not
browser-preview/mock IPC coverage.

The two independent WDIO executions create a domain, import the included valid
one-page PDF, save a note, stop the native process, then reopen the same isolated
profile. PID checks prove process restart; read-only SQLite queries and PDF hashes
verify real persistence after each run. Retries do not manufacture a pass.

## Run

Use Node 24 and the normal platform Tauri prerequisites, then:

```sh
npm ci
npm run test:desktop:guard
# Set CARGO_TARGET_DIR to the absolute src-tauri/target/desktop-e2e directory.
npm run tauri -- build --debug --no-bundle --features desktop-e2e --config tests/desktop/tauri.e2e.conf.json -- --locked
npm run test:desktop
```

Python 3 is required for the independent SQLite check. `PF_E2E_BINARY` may select
the compiled test executable. The harness creates its own marked temporary root;
it does not accept a user's existing profile. Diagnostics contain synthetic data
only and are saved under `test-results/desktop`.

## Security and coverage boundaries

- `desktop-e2e` is nondefault, with an optional pinned embedded WebDriver plugin.
  Release compilation with this feature is rejected. Test builds are never bundled,
  signed, uploaded as installers, or passed to the release workflow.
- The test configuration uses `com.paperfield.e2e`; Rust isolates configuration,
  logs and secrets, refuses unmarked/non-temporary roots, and skips legacy user-data
  migration. The existing lock/recovery/import path remains active.
- Only OS PDF selection is substituted with the fixed temporary `smoke.pdf` under
  the test-only feature. Existing canonicalization, PDF grants, copy and DB writes
  run normally. **The native OS file-picker UI is not tested.** No renderer IPC
  mocking, extra global Tauri API, production capabilities or CSP relaxation.
- No MinerU/LLM/API credentials or parsing services are configured. Network API
  behavior, OS keychain integration, installer installation/uninstallation, signing/notarization, upgrades,
  migration from previous releases and external PDF viewer launch remain untested.
- `webdriverio` 9.32.0 is intentionally pinned with service 1.5.1: the published
  service's peer range is WebdriverIO 9. `@wdio/mocha-framework` 10.1.0 has no
  WebdriverIO peer dependency and requires Node 22.19+; CI uses Node 24.
  `proxy-agent` 8.0.2 is explicit because `@puppeteer/browsers` 3 requires it as
  a peer; the WebdriverIO 9 browser helper retains its own 6.x dependency.

The production guard checks the resolved **default** Cargo dependency graph;
optional dependencies appearing in Cargo.lock are expected.

# CI: first-phase validation

`.github/workflows/ci.yml` runs for every pull request, pushes to `main`, and
manual dispatches. There are no path filters and no provider/signing secrets.
Its stable aggregate check is **CI Gate**.

## Coverage

| Job | Runner | What it checks |
| --- | --- | --- |
| Frontend | `ubuntu-24.04` | `npm ci`, Vitest unit tests, TypeScript checking and Vite build |
| Rust (Windows x64) | `windows-2022` | Native `x86_64-pc-windows-msvc` tests and string-slice lint |
| Rust (macOS arm64) | `macos-15` | Native `aarch64-apple-darwin` tests and string-slice lint |
| Rust (macOS Intel) | `macos-15-intel` | Native `x86_64-apple-darwin` tests and string-slice lint |

The frontend is built once within this workflow. Its real `dist` artifact is
passed to each Rust job for the Tauri context; Rust jobs do not install Node or
rebuild the UI. Ubuntu runs only frontend checks, so it needs no Linux Tauri
native libraries. Each Rust job verifies the compiler host before running the
native tests; cross-compilation alone is not execution coverage.

Node 20 and stable Rust follow the existing Desktop workflow/toolchain. The
existing clippy scope is retained: `--all-targets -- -A clippy::all -D
clippy::string_slice`, not a new all-warnings policy. Cargo uses `--locked`.
Frontend caching is keyed by setup-node's OS/architecture and package lock;
Rust caching separates OS, architecture, target, compiler and Cargo lock inputs.
Actions are pinned to the same full commit SHAs used by Desktop. Permissions
are read-only, checkout credentials are not persisted, jobs have timeouts, and
new runs cancel obsolete runs for the same ref. Matrix fail-fast is disabled
so one platform failure does not hide the other platform results.

`CI Gate` runs even after a dependency failure and accepts only `success` from
both Frontend and the complete Rust matrix. Failed, canceled, or skipped
prerequisites do not pass. A canceled workflow itself is not a successful gate.
Keep this job name stable when configuring branch protection. Adding this file
**does not change branch protection**; only adopt this check after it has run
successfully, and do not remove existing required checks prematurely.

## Intentionally unchanged / not yet covered

- `desktop.yml` remains intact, including its PR/main/manual installer builds,
  existing tests, tag-only signing secrets, and tag-push release publication.
  This first phase temporarily duplicates some checks across workflows rather
  than changing release behavior in the same PR.
- Building installers is **not** an installation or application-launch test.
  Installed Windows/macOS smoke tests, real Tauri/webview desktop E2E, native
  dialogs, updater behavior, and interactive keychain access remain pending.
- Frontend tests run in Vitest, not a real desktop webview. Native Rust unit and
  local mock HTTP tests do not prove a real provider is available or compatible.
- Optional live-provider tests are **not enabled**. PR validation must not need
  API keys, paid services, or external provider uptime. A future opt-in live
  test workflow needs a separate security/cost policy and must not become a
  required PR check.

## Local equivalents

```sh
npm ci
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -A clippy::all -D clippy::string_slice
```

Run the Rust commands on a supported native Windows/macOS development machine
with the prerequisites in the README. CI adds an explicit native `--target` to
both Cargo commands. A local pass on one OS does not replace the three CI runs.

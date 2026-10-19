# Codex 0.1.6 verification

Date: 2026-10-19. All account data and API responses in tests are synthetic; no real credentials were requested, accessed, transmitted or stored.

## Corrective scope

Codex 0.1.5's unchecked Remember password option did not save the password, but did retain the account email in the encrypted OS vault. This contradicted the native window's JWT-only promise. A second automatic review, triggered by marking the original draft ready, reported the issue after the first clean review and publication. Version 0.1.6 removes both fields in new JWT-only writes and physically cleans old account-only vault records during quota refresh.

## Checks

- CLI regression asserts an unchecked login passes only JWT to persistence; store-level validation also ensures new no-password records physically omit the account.
- Migration tests inspect the actual injected vault string, preserve JWT, verify physical read-back, and confirm idempotence and no writes on pure service.read().
- Existing lock/revision checks protect concurrent clear, switch and remembered-account writes; ownership guards protect disposal, marker callbacks and same-turn asynchronous completion races.
- Partial, ignored and failed vault writes, read-back errors, and failure to write the final ready marker fail closed. A post-changing failure requires owner set/clear recovery; unlock alone does not complete the interrupted mutation.
- Automatic review identified synchronous native calls in the new migration path before publication. Both migration reads now use the bounded isolated read helper, and the migration-only write uses a disposable IPC child. The parent retains its write lock until the writer child exits on success, timeout or cancellation. Independent review additionally reproduced an orphan-writer race after hard parent termination. Before any write instruction is sent, the lock records both parent and child ownership; recovery requires both processes to have stopped. Production-path synthetic tests cover blocked constructors, reads and writes, hard parent death, recovery refusal while the orphan writer is alive, late results, child diagnostics, lock lifetime and nonsecret transport.
- Full plugin syntax, bundled build, Node test suite and platform packaging. Existing login/recovery, native-window harness, MCP protocol and nonsecret settings tests remain included.
- Synthetic release script tests verify exact source/version provenance, six-file roundtrip, unchanged previous-release metadata, and refusal of existing target tags or incorrect bundle commits before publication. These run on Linux/macOS; publication itself runs on Linux.
- The dependency audit warning for [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) concerns the SDK OAuth client over HTTP. The advisory explicitly excludes MCP servers and stdio clients; this plugin uses `StdioServerTransport` and does not invoke the affected OAuth-client path. Dependencies were not changed in this bounded fix.
- Independent review and exact-head automatic review are required before merge; all automatically triggered review runs must settle before release.

## Limits

Windows WPF controls require Windows CI. Injected keyrings do not certify real OS-vault behavior; real Krill login and target Codex desktop acceptance still require the user's computer. Windows-only account/password entry scope is unchanged. This is a Codex-only release: VS Code remains 0.1.5 and all existing 0.1.5 assets/tag remain unchanged.

# Codex 0.1.5 verification

Date: 2026-10-19. All account data and API responses used in development tests are synthetic. No real credentials were requested, accessed, transmitted or stored.

## Local checks

- Plugin syntax, bundled build, complete Node test suite and Linux x64 packaging.
- Root VS Code suite: 76 tests passed; production VS Code code is unchanged.
- Independent security review reproduced and fixed an asynchronous ownership race. Every revision-check await now rechecks operation ownership before publishing data or continuing recovery; seven same-turn race regressions cover the relevant branches.
- Atomic single-record vault persistence; existing JWT compatibility; remember-disabled replacement; JWT-only replacement; clear; failed vault writes; conditional revision check under the existing writer lock; stale login after clear/switch; simultaneous same-account renewal followed by refresh.
- Fixed-endpoint login POST and subscription GET, size/deadline limits, redirects and extra authentication rejected, sanitized API/CLI errors, no secrets in MCP output or ordinary state files.
- Native prompt adapter validates structured account/password output. Windows harness includes production login save/cancel, unchecked remembering, bounds/control characters, paste handling and parent-termination races.
- MCP refresh-capable tools advertise possible writes because expiry recovery can update the vault; pure reads retain read-only annotations.

## Verification limits

The Windows WPF test suite cannot execute on the Linux development host; it must pass in Windows CI. Platform builds and tests on GitHub Actions are required before release. Synthetic injected keyrings are not real OS-vault certification. Real Krill login and target Codex desktop acceptance are not verified by these tests. Account/password entry remains Windows-only, matching the existing native credential UI scope.

Concurrent renewal intentionally invalidates a losing service's cached result when another process changes the credential revision. Its next refresh reads the winner's JWT without re-posting the password; clear/account-switch safety takes priority over retaining old cached quota.

## Release provenance

Codex 0.1.5 uses separately named platform archives, source ZIP, SHA256SUMS-codex-0.1.5 and CODEX-RELEASE-0.1.5.json on the existing v0.1.5 release. The tag remains c74467518c35eaacba1ac5d7c588af1e97fac22d and existing VS Code assets must not be replaced. The Codex manifest and BUILD-INFO.json identify the later exact source commit. The release workflow verifies downloaded bytes after upload.

# Changelog

## 0.1.4
- Fix account-switch and clear-credential races, including late reads, errors and refresh completion.
- Join concurrent refreshes and preserve credential-write order.
- Show refresh failures and stale data directly in the status bar.
- Add behavior regression tests and replace account fixtures with synthetic data.
- Clarify unofficial identity and credential/privacy handling; use publisher `lengmh`.

## 0.1.3
- Status-bar icon is configurable.
- Low quota warning and critical thresholds are configurable.
- Current primary plan is highlighted in the hover details.
- Low quota now uses VS Code warning/error status-bar **background** colors for reliable visual feedback across themes.
- No active quota, or all active quotas at zero, still falls back to account balance.

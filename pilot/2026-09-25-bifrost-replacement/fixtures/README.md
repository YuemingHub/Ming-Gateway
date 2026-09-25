# Sanitized compatibility fixture

`bifrost-config.json` is the sanitized compatibility fixture for the pilot. It
mirrors Ming-Gateway's **public** A/B/C configuration shape using only local
mock upstreams and dummy credentials.

- No production secret, host, domain, token or IP appears anywhere in this
  fixture. Every key is `sk-mock-*` / `sk-bf-*` (dummy), every upstream is
  `http://127.0.0.1:18080` (the local mock).
- Production (`api.ymai.fun`) is never contacted by anything in this pilot.

## Ming-Gateway shape → Bifrost object mapping

| Ming-Gateway concept | Bifrost expression in this fixture |
|---|---|
| Group A channel `a1` (order 0) | provider `mock-a1` (custom, base_provider_type `openai`, `base_url` = mock) |
| Group A channel `a2` (order 1) | provider `mock-a2` |
| Group B channel `b1` | provider `mock-b1` |
| Group C channel `c1` | provider `mock-c1` |
| Caller token A (`allowGroups: [A]`) | virtual key `vk-a-strict` — `provider_configs` = {a1, a2} (deny-by-default) |
| Caller token with `allowGroups: [A,B]` | virtual key `vk-ab` — providers {a1, a2, b1} |
| Caller token B | virtual key `vk-b` — providers {b1} |
| Caller token C (`requireExplicit`) | virtual key `vk-c` — providers {c1}; budget + request rate limit attached |
| Fallback chain `A → B` | implicit: model catalog + allowed provider set; a1 → a2 → b1 in `provider_configs` order |
| C never implicit fallback | C key only allows `mock-c1`; no target to escape to |
| Cooldown / failure switch | provider `network_config.max_retries` + per-key permanent-dead marking (401/402/403) |
| Budget breaker | `governance.budgets` on `vk-c` (`max_limit`, `reset_duration`) |
| RPM/TPM limits | `governance.rate_limits` (request/token max + window) |
| `X-GW-Group` / `c:` prefix | not supported (Bifrost-native is VK + `provider/model`); see report §5 |
| `${ENV_VAR}` indirection | `"value": "env.VAR"` (documented Bifrost syntax) |

## Two probe keys that are not part of the production mapping

- `vk-a-norule`, `vk-ab-norule`: same provider sets as `vk-a-strict` / `vk-ab`
  but **without** routing rules — used to observe native deny-by-default access
  profiles separately from routing-rule behaviour.
- `vk-rl-probe`: dedicated rate-limit probe (isolated from C-group traffic).
- `vk-multikey` + provider `mock-multikey`: two keys (`sk-mock-429` always 429,
  `sk-mock-mk1` healthy) for the key-rotation test.

## Routing rules are deliberately DISABLED in this fixture

Four `routing_rules` are present but `enabled: false`. Reason (reproducible,
see report §5b): an enabled rule with a pinned single target **suppresses the
implicit failover chain** — a failing `mock-a1` then returns 500 to the caller
instead of falling back to `mock-a2`. `scripts/rule-and-content-logging-test.sh`
reproduces both states.

## How to run

```bash
node mock-upstream.js &                          # mock upstream on :18080
bash scripts/start-bifrost.sh &                  # Bifrost on :17878 (copies this fixture into bifrost-app/)
node scripts/run-matrix.mjs                      # full matrix → raw/matrix-results.json
```

Bifrost version used: **v2.2.3** (npx cache `@maximhq/bifrost`).

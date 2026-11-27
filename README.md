# OpenCode Auto Router

Version 0.1.0 — testing release. Routes each turn to a model by difficulty, then replays the rest of that turn at the same effort.

## Install

```jsonc
{
  "plugins": ["@merodiro/opencode-pilot@latest"]
}
```

Or from a checkout, with no other configuration:

```jsonc
{
  "plugins": ["./plugins/jev-router"]
}
```

The plugin registers its own virtual models and picks the session default, so there is no model bookkeeping to add. Providers that are not available on your account are skipped instead of failing setup.

Select **`opencode-go/jev-auto`** for the full Go router, **`opencode/jev-lite`** for the free lite router, or **`claude-agent/jev-claude`** for the Claude Pro router. Subagents default to **`opencode/jev-sub`**, a free-only router. The session keeps the virtual model while each request is resolved to a real model.

The route tables below name specific models on purpose: they were tuned against a 2026-11-26 snapshot. If you use different providers, change the tables in `index.ts`; nothing else depends on them.

## Routes

### `jev-auto` — Go

| Request                                        | Model                            | Why                                                                                     |
| ---------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| Quick question or tiny change                  | `hy4-flash-free#none`            | Free, fast, 1M context, zero-retention.                                                 |
| Standard planning                              | `muse-spark-1.3-contributor`     | Index 36.6 at about $0.021/task in the 2026-11-26 snapshot; 1M context.                  |
| Complex planning                               | `muse-spark-1.3-contributor#xhigh` | Top effort the model exposes; complex turns are rare enough to spend it.              |
| Implementation after the first successful edit | `deepseek-v4.1-flash#high`       | 182 tok/s, proven tool loops, and keeps execution off the region-gated model.           |
| Implementation on a complex turn               | `muse-spark-1.3-contributor#xhigh` | The first edit is not where a hard task gets easier; keeps the planned effort.        |
| Repeated tool failures                         | `muse-spark-1.3-contributor#xhigh` | Escalate instead of grinding a failing loop on the cheaper tier.                      |
| Titles and transient generation                | `hy4-flash-free#none`            | Free and fast.                                                                          |
| Compaction                                     | `hungerg-free`                   | Free, heavier, and 1M context.                                                          |

Planning runs on Muse Spark 1.3 Contributor: 36.6 Index at ~$0.021/task against DeepSeek's 28.7 at ~$0.018 and 32.4 at ~$0.024. That is roughly 28% more capability for ~17% more cost per task, and its output tokens cost a third as much ($0.20 vs $0.60 per 1M). The tradeoffs are deliberate: the contributor tier trains Meta models on your prompts and completions, is not zero-retention, and is region-gated by Meta's Geographic Use Policy, so the workspace must allow paid endpoints that train on request data (Settings › Privacy). It is also about 35% slower (118 vs 182 tok/s), which is why implementation stays on DeepSeek `#high` — long tool loops care about throughput, and keeping one non-Muse route means a Muse block cannot stall execution. `#xhigh` is the top effort the model exposes; the snapshot only measures its default, so complex carries the unmeasured extra-effort step.

DeepSeek's Go price doubles on weekdays from 01:00–04:00 and 06:00–10:00 UTC, which now affects only implementation. Muse and the free models have flat pricing, so planning is cheaper at peak than DeepSeek.

### `jev-lite` — free

| Request                                        | Model                           |
| ---------------------------------------------- | ------------------------------- |
| Quick question or tiny change                  | `hy4-flash-free#none`           |
| Standard planning                              | `hy4-flash-free#high`           |
| Complex planning                               | `seaglass-alpha-free#max`       |
| Implementation after the first successful edit | `hy4-flash-free#high`           |
| Implementation on a complex turn               | `seaglass-alpha-free#max`       |
| Repeated tool failures                         | `deepseek-v4.1-flash-free#max`  |
| Titles and transient generation                | `hy4-flash-free#none`           |
| Compaction                                     | `deepseek-v4.1-flash-free#high` |

Complex free turns run on Seaglass Alpha Free: a stealth model with a 1M context window and a `#max` effort tier, so complex planning and the implementation loop that follows it keep the same budget as the paid router's Muse `#xhigh` without paying. It has no AA Intelligence Index score yet and, during its free period, retained data may be used to improve the model. It is a deliberate trial. Escalation leaves that family for DeepSeek V4.1 Flash Free `#max`, which is the strongest measured free model (32.4 Index), zero-retention, and the same destination used for compaction; the two free profiles therefore fall back to each other when one model is rate-limited.

### `jev-claude` — Claude Pro

| Request                                        | Model           |
| ---------------------------------------------- | --------------- |
| Quick question or tiny change                  | `haiku#low`     |
| Standard planning                              | `sonnet#medium` |
| Complex planning                               | `opus#medium`   |
| Implementation after the first successful edit | `sonnet#medium` |
| Implementation on a complex turn               | `opus#medium`   |
| Repeated tool failures                         | `opus#medium`   |
| Titles and transient generation                | `haiku#low`     |
| Compaction                                     | `sonnet#medium` |

This profile uses the `claude-agent` provider and never selects Fable. Opus is reserved for complex work at medium effort to conserve Pro usage.

### `jev-sub` — free subagent router

| Request                                   | Model                            |
| ----------------------------------------- | -------------------------------- |
| `explore` subagent                        | `hy4-flash-free#none`            |
| Quick subagent task                       | `hy4-flash-free#none`            |
| Standard subagent task                    | `hy4-flash-free#high`            |
| Complex subagent task                     | `seaglass-alpha-free#max`        |
| Struggle or a failed model request        | `deepseek-v4.1-flash-free#max`   |
| Titles and transient generation           | `hy4-flash-free#none`            |
| Compaction                                | `hy4-flash-free#high`            |

All destinations are free. `explore` skips classification entirely because its job is read-only search. Other subagents are classified once per task; the route is cached for the rest of the child session's tool loop. When the child shows repeated tool failures, or a model request fails outright (a per-model free-tier rate limit is the usual cause), the rest of that turn switches families to `opencode/deepseek-v4.1-flash-free#max` instead of retrying the model that is failing. DeepSeek free has 200k context and supports `max` effort. A failed last response keeps the next request on DeepSeek until one succeeds; after a normal reply, the next turn returns to the classified route. The plugin assigns `opencode/jev-sub` to every visible subagent, including custom project subagents that previously pinned a different model.

The built-in `plan` agent stays on a planning route: `quick` is promoted to `standard`, and writing plan files under `~/.opencode/plan/` does not switch the session to the implementation route.

`opencode/jev-1.13-free` classifies each new user turn as `quick`, `standard`, or `complex`. The classifier receives the latest request, up to three recent user requests, invoked skill descriptions, and the previous route. `quick` requires at least `0.7` probability and a `0.15` margin over `standard`. The bar was lowered from `0.85`/`0.2` after the decision log showed 88 turns in the 0.6–0.85 band where quick was the right call: "commit the changes", "remove .claude", "how does it integrate with shadcn?". Standard was paying planning cost for work quick finished in one or two tool calls. A real skill invocation (`@some-skill`) never routes to `quick`; a plain `@file` or `@package` mention does not block it, because file-scoped lookups are exactly the quick case. If the skill list cannot be read while the prompt has a mention, the router treats it as a possible skill and blocks `quick`. Uncertain results and Jev failures use `standard`. A completed edit/write/patch switches the rest of that turn to the implementation route, but keeps the effort classification earned: a complex turn stays on `#max` (or `opus`) through its tool loop instead of dropping to the implementation tier. The phase is stored with OpenCode's plugin storage, so it survives plugin reloads and compaction. A new user message starts a new classification. Only sessions selecting `opencode-go/jev-auto`, `opencode/jev-lite`, `claude-agent/jev-claude`, or `opencode/jev-sub` are affected.

Two overrides sit on top of the classification:

- **`ultrathink`** anywhere in the prompt (as a whole word) pins the turn to `complex` with no classifier call. It is the escape hatch when you already know the task is hard and don't want to pay the classification latency.
- **High stakes bump.** A parallel `high_stakes` predicate asks whether a mistake is expensive or hard to undo (production, deployment, security, auth, payments, data loss, migrations, destructive operations). At `0.7` or above the route moves up one tier: `quick` becomes `standard`, and `standard` reaches `complex` only when the complexity score is at least `0.25`; otherwise it stays `standard`. The log showed risky-but-simple turns ("allow global access to work trees", 0.8 stakes with 0.16 complex probability) landing on the most expensive tier for a config edit. `complex` is already the top, so it does not move. A reversible question stays cheap; irreversible work never runs on the quick tier.

### Struggle triage: retry or escalate

Two failures in a row (a failed tool call or a failed model request), or three across a turn, mark the turn as struggling on the primary routers. Instead of escalating every struggle, Jev decides what the failures mean:

- **Retry.** Timeouts, network blips, rate limits, flaky commands or tests, missing binaries, sandbox or permission hiccups, lint noise, and typos in a command or path stay on the implementation route. The turn keeps its route and retries, up to two retries per turn. Failures after each retry are triaged again; no new failure means the retry stands.
- **Escalate.** A wrong approach, a cross-cutting or architectural change, concurrency or security, a migration, a hard logic bug that survived edits, or failures that keep landing at the same point move the rest of the turn to the hard model and report the `escalated` tier.

Repeated model request failures escalate directly: a provider outage or a per-model rate limit is escaped by switching to the hard model's family, not by retrying the unhealthy endpoint. On the free routers that destination is DeepSeek V4.1 Flash Free `#max`, not the Seaglass complex route, so a rate limit on one does not trap the turn. The retry cap, the `escalated` flag, and the failure count when the last retry was granted are stored, so they survive compaction and plugin reloads. `jev-sub` has no implementation phase and no triage; the classified route holds for the child session unless failures escalate it to DeepSeek free.

The free models are limited-time offerings and can be rate-limited. The lite router and `jev-sub` stay on free models; both escape a rate-limited model by switching families to DeepSeek V4.1 Flash Free when a turn or child struggles. The full router does not swap to a paid model on a runtime quota rejection.

## Seeing the active route

- **TUI:** the prompt footer status shows `jev→ <provider>/<model>#<variant>` for the last resolved model and clears when you select another model.
- **Desktop:** a session-scoped composer pill shows `<tier>: <model>` and hides when you select another model. `escalated` means struggle moved that turn to the hard model; on the free routers that is the DeepSeek free family switch.
- **API:** `POST /api/rpc/jev-router.status/get` with body `{"input":{"sessionID":"ses_..."}}` returns that session's route. Omitting `sessionID` returns the most recently reported route. Manually selecting another model records a `manual` route and hides the router pill.

## Decision log

Each state change appends a record to a per-session log (last 60 kept), so routing can be reviewed after the fact:

```bash
curl -s localhost:PORT/api/rpc/jev-router.status/decisions \
  -d '{"input":{"sessionID":"ses_..."}}'
```

Each record holds `ts`, `userMessageID`, `routerVersion`, `agent`, `kind` (`primary` or `subagent`), `phase`, `route`, `probabilities`, `mentions`, `invokedSkills`, `skillListAvailable`, `previousRoute`, `resolvedModel` (provider/model#variant), `tier`, `escalated`, `edited`, `keyword` and `stakes` when one of the overrides fired, `retries` once failure triage granted one, and `degraded` when a classifier fallback was used. `explore` subagents are logged too, with an empty `userMessageID`, so the log shows every path taken.

`routerVersion` is a fingerprint of the thresholds, failure limits, and log policy version that produced the decision. Group by it before drawing conclusions: records from different versions are not comparable, and route-table changes show up in `resolvedModel` instead. The log is analysis-only; if storage rejects a write, routing is unaffected.

The UI parts read the same server-side state; they load from `tui.tsx` and the prebuilt `dist/gui-experimental.cjs` (rebuild with `npx vite build --config vite.config.mts` from this directory after GUI edits).

## Data sources

- <https://xhang1108.github.io/opencode-cost-per-intelligence/data/merged.json> (2026-11-26 snapshot)
- <https://opencode.ai/inference/go/v1/models>
- <https://opencode.ai/inference/v1/models>
- <https://opencode.ai/docs/console/go>
- <https://opencode.ai/docs/console/models#jev>

Hy4 Flash Free and HungerG Free have no AA Intelligence Index score in the snapshot; their placement is based on their stated capabilities and cost rather than benchmark rank. Muse Spark 1.3 Contributor scores 36.6 at roughly $0.021/task, but it trains on request data and is region-gated. DeepSeek V4.1 Flash remains the zero-retention pick and the manual fallback if Muse is unavailable or its terms are not acceptable: `#high` scores 28.7 at roughly $0.018/task and `#max` 32.4 at roughly $0.024/task, both ahead of GLM-5.3's 31.6 at roughly $0.100/task. Kimi K3.1 Pro is the manual quality ceiling at 46.6 when a single task matters more than cost.

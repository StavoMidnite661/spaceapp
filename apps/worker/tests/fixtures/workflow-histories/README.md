# Recorded workflow histories (replay determinism gate)

Each fixture is `{ workflowId, history: { events: [...] } }`, recorded from a
**real run on the Temporal time-skipping test server** by
`apps/worker/scripts/record-workflow-histories.mjs`
(`npm run temporal:record-histories -w @space/worker`).

| fixture | workflow module it replays against |
| --- | --- |
| `dummy-turn.json` | `apps/worker/src/workflows.ts` |
| `codex-app-server-turn.json` | `apps/worker/src/workflows.ts` |
| `dot-goal.json`, `dot-goal-continue-as-new.json` | `apps/worker/src/workflows.ts` |
| `room-agent-supervisor.json` | `apps/worker/src/workflows.ts` |
| `room-agent-supervisor-pre-patch.json` | `apps/worker/src/workflows.ts` (marker-less → legacy branch) **and** `tests/support/pre-patch-workflows.ts` |
| `room-agent-action.json` | `apps/worker/src/workflows.ts` |
| `memory-maintenance.json`, `memory-consolidation.json` | `apps/worker/src/memory-maintenance-workflows.ts` |
| `memory-mutation.json` | `apps/worker/src/memory-mutation-workflows.ts` |
| `determinism-probe.json` | `tests/support/determinism-probe-workflows.ts` (drifted copy must FAIL) |

## Re-record policy

Re-record only for intentional `patched()` migrations. Preserve existing
histories as compatibility evidence; add fixtures for newly introduced
patched branches as needed.
Re-record only the fixture(s) required by the migration.

Never overwrite a failing history after an unpatched workflow change. Fix the
workflow or retain compatibility instead.

Do not hand-edit recorded history events. Keep each fixture's `workflowId`
aligned with the actual run; the replay gate is meaningful only when fixtures
are produced by this recorder against the checked-out workflow code.

`room-agent-supervisor-pre-patch.json` is recorded from the legacy
(`mark*`/settle-boolean) supervisor in `tests/support/pre-patch-workflows.ts`;
replaying it against the patched module exercises the
`room-background-continuation-v1` marker fallback. The negative test
(`determinism-probe.json` vs `determinism-probe-drifted-workflows.ts`) must
throw `DeterminismViolationError` — if it stops failing, the gate is vacuous.

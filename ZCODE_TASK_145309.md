# ZCode mission — OpenClaw issue #145309

Temporary agent handoff file. Do **not** include this file in the final product commit or PR.

## Repository / branch

- Fork: `Szqub/openclaw`
- Work from: `scratch/145309-zcode-mission-pack`
- Final product branch: `fix/claude-cli-config-dir-transcripts`
- Upstream base pinned when this task was prepared: `openclaw/openclaw@01e00e442fba755ab11cd807aa68fbe6a17f83a9`
- Canonical issue: `openclaw/openclaw#145309`

Before editing, confirm upstream has not already landed an equivalent fix and rebase/refresh if necessary. Preserve unrelated work.

## Problem to prove

The bundled `claude-cli` backend supports `CLAUDE_CONFIG_DIR`, and Claude Code writes native session transcripts beneath that selected directory. OpenClaw's transcript probe currently resolves the per-workspace project directory from `$HOME/.claude/projects/...` only. With a non-default `CLAUDE_CONFIG_DIR`, valid transcripts therefore look missing, causing session continuity failures (`missing-transcript`; on warm/live paths potentially `cli_live_session_changed` and fallback without history).

Current owner under investigation:

- `src/agents/command/claude-cli-project-dir.ts`
- callers in `src/agents/command/attempt-execution.helpers.ts`
- callers/admission in `src/agents/cli-runner/prepare.ts`
- Doctor diagnostics in `src/commands/doctor-claude-cli.ts`
- related tests in `src/agents/command/attempt-execution*.test.ts`, `src/agents/cli-runner/prepare.test.ts`, `src/commands/doctor-claude-cli.test.ts`

Existing sibling behavior to compare, not blindly copy:

- `extensions/anthropic/session-catalog-scan.ts` already considers `CLAUDE_CONFIG_DIR`.
- `src/plugin-sdk/provider-auth-claude-compat.ts` has a Claude config-dir resolver for auth ownership.
- `extensions/migrate-claude/source.ts` has explicit semantics around preserving non-empty `CLAUDE_CONFIG_DIR` paths; inspect this carefully because whitespace/path semantics differ across existing call sites.
- docs explicitly support `CLAUDE_CONFIG_DIR` for `claude-cli`.

## Required workflow

1. Read root `AGENTS.md`, `src/agents/AGENTS.md`, nearest scoped instructions for every edited file, `CONTRIBUTING.md`, relevant CLI backend docs, testing docs, and PR template before implementation.
2. Inspect git history for the project-dir resolver and why it was introduced. Do not assume the omission is accidental until history/contracts support that conclusion.
3. Reproduce the defect before editing with a synthetic, secretless fixture. At minimum prove:
   - transcript exists only under a configured Claude directory;
   - the current probe looks under `$HOME/.claude/projects/...` and returns false;
   - default/no-config behavior remains correct.
4. Determine the single correct owner for selecting the Claude config directory. Avoid adding another competing resolver if an existing owner can be reused without violating dependency boundaries.
5. Implement the narrowest complete cutover. Keep fallback policy, live-session ownership, auth behavior, storage format and unrelated resume behavior out of scope unless a direct invariant requires a change.
6. Update Doctor to inspect the same selected project directory as runtime transcript probing.
7. Add regression tests that fail on the original source and pass with the repair. Important cases:
   - `CLAUDE_CONFIG_DIR` selected path is used for transcript probe;
   - default `$HOME/.claude` behavior is preserved;
   - explicit injected `homeDir` test seams remain deterministic;
   - invalid/missing session id safety remains unchanged;
   - Doctor reports the selected Claude project dir, not the default one;
   - no change to auth token ownership or credential reading.
8. Check whether environment ownership is `process.env` or the prepared/injected environment at each call site. Prefer carrying prepared facts through hot paths over ambient rereads if repository ownership rules indicate that is the canonical contract.
9. Run focused validation first, then the acceptance cohort. Maintainer review for #145309 named:

```bash
node scripts/run-vitest.mjs run \
  src/agents/command/attempt-execution.test.ts \
  src/agents/command/attempt-execution.cli.test.ts \
  src/agents/cli-runner/prepare.test.ts \
  src/commands/doctor-claude-cli.test.ts
node scripts/check-changed.mjs
git diff --check
```

Also run any narrower/new test file you add and `pnpm changed:lanes --json` to identify required scoped checks. Do not paper over failures with retries, longer timeouts or weaker assertions.
10. Perform a synthetic end-to-end continuity proof if feasible without external credentials: create temp HOME + alternate Claude config tree + transcript, exercise the real transcript-resolution path, and record expected/actual path plus result before/after.
11. Inspect diff for secrets, machine-specific paths, generated artifacts and accidental unrelated edits.
12. Commit product changes separately from this mission file. The final product commit must not contain `ZCODE_TASK_145309.md`.

## Deliverable from ZCode / GLM 5.3

Produce a concise evidence report in the session output containing:

- exact root cause and violated invariant;
- source/history evidence;
- chosen ownership model and why competing options were rejected;
- files changed and why;
- before/after reproducer output;
- tests/checks run with exact pass/fail counts;
- any remaining uncertainty or unrun checks;
- final product commit SHA on the scratch branch.

Do **not** open the upstream PR yet. Do **not** merge. Do **not** change issue state. The next stage is independent review by Opus + Fable 5.1, then Astra as final adversarial review.

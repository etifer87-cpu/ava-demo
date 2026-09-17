# Upstream provenance — /thermos

| | |
|---|---|
| Source | https://github.com/cursor/plugins — directory `thermos/` |
| Commit | `c1c0a32802223f4be824112dd83d33ad29a8b26c` (2026-09-14) |
| Upstream version | Thermos plugin 1.0.0 |
| Licence | MIT, Copyright (c) 2026 Cursor — full text in `LICENSE` beside this file |
| Imported here | 2026-09-17 |

## Files and their upstream origin

| This repo | Upstream |
|---|---|
| `.claude/agents/thermo-deep-review.md` | `skills/thermo-nuclear-review/SKILL.md` + `agents/thermo-nuclear-review-subagent.md` |
| `.claude/agents/thermo-quality-review.md` | `skills/thermo-nuclear-code-quality-review/SKILL.md` + `agents/thermo-nuclear-code-quality-review-subagent.md` |
| `.claude/skills/thermos/SKILL.md` | `skills/thermos/SKILL.md` |
| `.claude/skills/thermos/REPO_NOTES.md` | none — written for this repository |

## Intentional deviations

1. **Cursor → Claude Code.** Five files became three; each rubric lives once, in its agent file.
   Cursor `Task` / `subagent_type` / `run_in_background` wording replaced with Claude Code agent names.
2. **Diff base.** Upstream defaults to `main...HEAD`. Here the base ref is a required argument, is
   never guessed, and must be an ancestor of HEAD. The diff covers the working tree plus untracked
   files.
3. **Read-only and secret handling added.** Reviewers get `Read, Grep, Glob, Bash`, a list of
   forbidden commands (`REPO_NOTES.md` §2), a secret-path screen before launch, and pathspec
   exclusions on the diff.
4. **BugBot removed.** The PR-discussion step is kept as an optional `pr=<number>` argument, read
   only after the independent audit.
5. **This repository's rules added.** The deep review checks the invariants of `scaffold/CLAUDE.md`
   §2 and the trap classes of `kit-docs/16_TRAPS.md`, with access and disclosure first.
6. **Quality review is advisory** and uses this repo's house style, including the ~400-line split.
   Every finding is labelled *This slice* or *Follow-up slice*.
7. **The orchestrator verifies** High and Medium findings against the file before reporting.
8. Upstream all-caps emphasis removed; the substance of each rule kept.

## Updating from upstream

Stage the new upstream `thermos/` directory outside the repo, diff it against the commit above, and
port changes by hand. Do not overwrite `REPO_NOTES.md` or the deviations above.

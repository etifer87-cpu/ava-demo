---
name: thermos
description: Diff-scoped review of a slice's changes before a demo or server deploy. Runs the deep reviewer (bugs, access, security, devex) and the quality reviewer in parallel, checks their findings, and merges them into one report. Read-only. User-invoked only.
disable-model-invocation: true
argument-hint: "<base-ref> [deep|quality|both] [pr=<number>]"
---

<!-- Adapted from cursor/plugins thermos (MIT, (c) 2026 Cursor). See UPSTREAM.md -->

# /thermos — review a slice's diff

Arguments given: `$ARGUMENTS`

This skill reviews the changes between a base commit and the current working tree. It never edits
files, commits, tags, pushes, migrates, seeds or deploys. The findings are advice for the author.

Read [REPO_NOTES.md](REPO_NOTES.md) before step 1. It lists the files that must change together,
the commands that must never run, and the checks that are safe.

The commands below are bash. On Windows, Claude Code runs them in Git Bash.

## Step 1 — Parse the arguments

- First argument: **base ref** (a tag such as `pre-<slice>` or a commit SHA). Required.
- Second argument: `deep`, `quality` or `both`. Default `both`.
- Optional `pr=<number>`: a pull request whose discussion the deep reviewer may read after its own
  audit.

**If no base ref was given, do not pick one.** Run:

```bash
git for-each-ref --sort=-creatordate --count=10 \
  --format='%(creatordate:short)  %(refname:short)  %(objectname:short)' refs/tags
```

Show the list and ask which base to use. Then stop. A phase tag covers far more than one slice;
the choice belongs to the person asking.

## Step 2 — Resolve and check the range

```bash
BASE_SHA=$(git rev-parse --verify "<base-ref>^{commit}")
HEAD_SHA=$(git rev-parse HEAD)
git merge-base --is-ancestor "$BASE_SHA" "$HEAD_SHA" && echo ancestor-ok
git status --porcelain
git rev-list --count "$BASE_SHA".."$HEAD_SHA"
```

- If the base does not resolve, or is not an ancestor of HEAD: stop and report.
- State the number of commits in the range in the report header. If it is more than about 20,
  say so: the review is shallower per change.
- Note whether the working tree is dirty. The review covers committed **and** uncommitted changes
  to tracked files, plus untracked files.

## Step 3 — Build the change list and screen it

```bash
git diff --name-status "$BASE_SHA"
git ls-files --others --exclude-standard
git diff --shortstat "$BASE_SHA"
```

**Secret screen.** If any changed or untracked path matches the pattern below, **stop**. Report
the path(s) without opening them, and do not launch the reviewers. `.env.example` is allowed.

```bash
{ git diff --name-only "$BASE_SHA"; git ls-files --others --exclude-standard; } \
  | grep -E '(^|/)(\.env[^/]*|[^/]*\.(pem|key)|id_(rsa|ed25519|ecdsa)[^/]*)$' \
  | grep -vE '(^|/)\.env\.example$'
```

(No output means the screen passed; `grep` exiting 1 is the pass, not an error.)

## Step 4 — Launch the reviewers

Launch the selected reviewers **in a single message** so they run in parallel:
`thermo-deep-review` and/or `thermo-quality-review`. Give each the same prompt, filled in:

```
Review this slice's changes.

Repository root: <output of git rev-parse --show-toplevel>
Base ref: <base-ref>  (<BASE_SHA>)   commits in range: <n>
HEAD: <HEAD_SHA>
Working tree: clean | dirty (review includes uncommitted changes)
PR for discussion: <number> | none

Diff command (use exactly this; it excludes secret files):
git diff <BASE_SHA> -- . ':(exclude,glob)**/.env' ':(exclude,glob)**/.env.*' ':(exclude,glob)**/*.pem' ':(exclude,glob)**/*.key'
(.env.example is excluded from the diff by that pattern; if it is in the change list, read it directly.)

Changed files (name-status):
<list>

Untracked new files (not in the diff — read them in full):
<list or "none">

Size: <shortstat>
```

## Step 5 — Check, then merge

1. **Check every High and Medium finding yourself** before passing it on: open the cited file and
   line and confirm the defect is there and was caused by this diff. Drop what you cannot confirm,
   or move it to "Unconfirmed" with the reason.
2. Deduplicate. A defect both reviewers found carries more weight — say so.
3. Where the reviewers disagree, decide, and say why in one line.
4. Keep the quality reviewer's **Scope** label on every quality finding.

## Step 6 — Report

```
# Thermos — <base-ref> (<BASE_SHA short>) .. <HEAD_SHA short>  [<n> commits, working tree: clean|dirty]

## Verdict
<one or two sentences: is this safe to demo / deploy, from what was checked?>

## Must fix before the demo or deploy
- [file:line] <defect> — <failure scenario>  (deep | quality | both)

## Should fix in this slice
- ...

## Follow-up slices (advisory)
- ...

## Twins checked
- <set> — yes / no / not touched

## Unconfirmed
- ...

## Not checked
- <check> — <reason>
```

Leave empty sections out, except **Not checked**, which is always present. Then stop. Do not
offer to apply fixes in the same turn; the author decides what enters the slice.

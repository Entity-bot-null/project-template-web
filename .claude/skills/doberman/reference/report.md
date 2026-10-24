# Result and report

Two outputs: `result.json` in the run directory (machine-readable, validated by
`doberman.mjs verdict`), then the report printed to the user. Neither is written to the repository.

## Contents

- [result.json](#resultjson)
- [fixes.json](#fixesjson)
- [Statuses](#statuses)
- [How the verdict is computed](#how-the-verdict-is-computed)
- [The report](#the-report)
- [The loop report](#the-loop-report)

## result.json

```json
{
  "projectType": "MOBILE or WEB, from the context",
  "mode": "default",
  "gates": [
    {
      "id": "lint",
      "name": "Lint",
      "status": "PASS",
      "required": true,
      "evidence": "pnpm lint → exit 0 (logs/lint.log)"
    },
    {
      "id": "<a conditional gate>",
      "name": "<its name from the plan>",
      "status": "SKIPPED",
      "required": false,
      "reason": "REQUIRES DEVICE: no device or emulator attached"
    }
  ],
  "findings": [
    {
      "id": "F1",
      "severity": "BLOCKING",
      "verification": "REPRODUCED",
      "reproductionId": "R1",
      "title": "A late profile response after sign-out shows the previous user's email",
      "location": "<path>:18",
      "problem": "…",
      "whyItMatters": "…",
      "reproduction": "…",
      "evidence": "<test command> → 1 failed: expected 'b@example.com', received 'a@example.com'",
      "recommendation": "…"
    }
  ],
  "reproductions": [
    {
      "id": "R1",
      "finding": "F1",
      "scenario": "…",
      "expected": "…",
      "actual": "…",
      "test": "<path>.doberman.spec.tsx (deleted after the run)",
      "command": "<context.reproduction.runOne with the file>",
      "status": "REPRODUCED",
      "evidence": "the assertion output",
      "fixValidated": "the same test passes in the sandbox with the fix applied (optional)"
    }
  ],
  "definitionOfDone": [{ "requirement": "…", "status": "PASS", "evidence": "…" }],
  "environmentLimitations": ["…"]
}
```

Rules the validator enforces:

- Every gate of the plan (`context.json` → `gates`) appears in `gates`, including the ones that did
  not run: a planned gate is never dropped silently.
- `PASS`/`FAIL` carry `evidence` (command, exit code, log path), and the gate's log
  (`logs/<id>.log`) ends with a `DOBERMAN_EXIT=<code>` line that agrees: 0 for PASS, non-zero for
  FAIL. A log without that line is a gate that never finished. `SKIPPED`, `NOT APPLICABLE` and
  `UNVERIFIED` carry a `reason`.
- Gate, finding and reproduction ids are unique; every finding has an `id`.
- The cleanup ran first (`clean.json`); a workspace it could not leave as it found it is an
  environment limitation, so the verdict cannot be READY TO MERGE.
- Every `FAIL` is explained by at least one finding with `"gate": "<id>"`; a mandatory gate's
  failure is explained by a BLOCKING finding.
- Findings have `severity`, `verification`, `location`, `problem`, `whyItMatters`, `reproduction`,
  `evidence`, `recommendation`. `REPRODUCED` points (`reproductionId`) at a reproduction whose status
  is `REPRODUCED`.
- `CONFIRMED` is for findings proven without a runtime reproduction: a gate output, the exact lines
  that break a documented rule, a type error, a missing guard visible in the code with every caller
  checked. Say in `evidence` what proves it.
- `UNVERIFIED` findings are reported in their own list and do not count towards the verdict.
- In a round of a loop after the first (`context.json` → `loop.round` above 1), every finding the
  previous round left unfixed (it is not in `loop.fixed`) is either carried, a finding of this
  round with `"carriedFrom": "<round>:<id>"` (its fields written again from the current code), or
  listed once in `resolved`, at the top level of `result.json`, with the evidence that it no longer
  applies: `"resolved": [{ "carriedFrom": "1:F4", "evidence": "the fix of 1:F2 removed the cache it was about" }]`.
  A fix that did not hold is a new finding of this round with `"reopens": "<round>:<id>"`, naming a
  finding the previous round fixed (`loop.fixed`); it is never carried.
- A valid verdict keeps the bytes it checked as `result.verified.json` (their digest in
  `verdict.json` → `resultSha256`): a loop reads that copy, never `result.json` as it is later.
- In a round of a loop, a verdict given again keeps every finding the round's earlier verdict
  checked, its fields and severity free to change: a fixed one stays (it goes in `fixes.json`); one
  that proved false is listed in `withdrawn`, at the top level, with the evidence, and stays there
  in later verdicts of the round:
  `"withdrawn": [{ "id": "F2", "evidence": "the guard it named exists at src/x.ts:9" }]`. `verdict`
  refuses a round the loop has moved past.

## fixes.json

What a round of a loop fixed and deferred, written in its run directory after the fixes and before
`loop next` (or, to stop early, with nothing fixed, before `loop finish`):

```json
{
  "fixed": [
    {
      "finding": "F1",
      "change": "what the fix does, in one sentence",
      "files": ["<path>", "<its test>"],
      "regressionTest": "<the reproduction kept as a permanent test>"
    }
  ],
  "deferred": [{ "finding": "F3", "reason": "needs your decision: it adds a dependency (…)" }]
}
```

Rules `loop next` and `loop finish` enforce:

- Every verified BLOCKING and SHOULD FIX of the round is in `fixed` or in `deferred`, once.
  LOW and NIT may be in either; those in neither are simply not fixed (the next round carries
  them).
- `files` names repository paths that changed since the round started, as
  `git status --porcelain --untracked-files=all` prints them (a new directory may be named with its
  trailing slash, as `git status --short` does); a REPRODUCED finding names its `regressionTest`, a
  test file (`*.spec.*`, `*.test.*`) the round added or changed, kept for good (no `.doberman.` in
  its name, no marker). An UNVERIFIED finding is never in `fixed`: it is carried.
- A `deferred` entry says the decision it needs.
- `loop next` needs at least one fix (a round with nothing to review is no round); `loop finish`
  before the last round needs none, and every BLOCKING and SHOULD FIX deferred.

## Statuses

| Status         | Means                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| PASS           | the gate ran here and exited 0                                                                                                   |
| FAIL           | the gate ran here and failed because of the code or configuration under review                                                   |
| SKIPPED        | it did not run: not requested in this mode, or the environment lacks what it needs                                               |
| NOT APPLICABLE | it cannot apply to this change (no history to scan, script absent from the project)                                              |
| UNVERIFIED     | it ran but says nothing about the change: the environment broke it (network, disk), or it never finished (timeout, interruption) |

Skipped gates name what they need: `SKIPPED — REQUIRES MAC/iOS ENVIRONMENT`,
`SKIPPED — REQUIRES DEVICE`, `SKIPPED — REQUIRES DOCKER`, `SKIPPED — REQUIRES DATABASE`,
`SKIPPED — REQUIRES CONFIGURATION`, `SKIPPED — NOT REQUESTED (--diff)`. Never turn `SKIPPED` or
`UNVERIFIED` into `PASS`.

## How the verdict is computed

`doberman.mjs verdict` decides; the report copies its answer.

1. **DO NOT MERGE**: at least one verified BLOCKING finding (a failing mandatory gate always is one).
2. **CHANGES REQUIRED**: no BLOCKING, at least one verified SHOULD FIX.
3. **READY WITH ENVIRONMENT LIMITATIONS**: no BLOCKING or SHOULD FIX, but a mandatory gate was
   skipped or unverified, or a gate the change made relevant could not run here. The report lists
   exactly which.
4. **READY TO MERGE**: none of the above, and every mandatory gate passed.

LOW, NIT and UNVERIFIED never change the verdict. A focused run (`--diff`, `--security`,
`--tests`) skips mandatory gates, so it can at best end READY WITH ENVIRONMENT LIMITATIONS.

A verdict without findings means this review and these gates found nothing; it does not prove the
change free of defects or vulnerabilities. The report says so (`note` in the verdict output).

## The report

Print exactly this structure, in the language the user writes in (headings stay as below). Keep it
direct: findings first, no filler. Sections with nothing to say get `None.`

```markdown
# DOBERMAN PR AUDIT

## Verdict

`<VERDICT>`

## Project

- Type: <MOBILE|WEB> (<template name>, confidence <n>)
- Base: <ref> (<sha7>)
- Head: <branch> (<sha7>)
- Merge base: <sha7>
- Scope: <n files, +a −d, commits, uncommitted changes; mode>

## Executive Summary

<3–6 sentences: what the change does, the intent, the decisive findings, the verdict's reason.>

## Gates

| Gate | Result | Evidence           |
| ---- | ------ | ------------------ |
| …    | PASS   | `pnpm lint` exit 0 |

## BLOCKING

### F1 — <title>

- **Severity:** BLOCKING
- **Location:** `path:line`
- **Problem:** …
- **Why it matters:** …
- **Reproduction:** …
- **Evidence:** …
- **Recommendation:** …

## SHOULD FIX

…

## LOW

…

## NITS

…

## Unverified concerns

<only if any: what is suspected and what would settle it>

## Reproduced Issues

### R1 — <scenario>

- Scenario: …
- Expected: …
- Actual: …
- Reproduction: <test file (deleted), command>
- Evidence: <failing assertion output>
- Status: REPRODUCED | NOT REPRODUCED | UNVERIFIABLE

## Definition of Done

| Requirement | Status                           | Evidence |
| ----------- | -------------------------------- | -------- |
| …           | PASS/FAIL/PARTIAL/NOT APPLICABLE | …        |

## Test Evidence

<what ran, counts, changed-line coverage and the uncovered changed lines that matter>

## Security Review

## Performance Review

## Environment Limitations

<only real ones, from the verdict output>

## Files Reviewed

<the files read in depth, grouped by area; generated files named as such>

## Final Decision

<one unambiguous sentence: the verdict and the one thing that decides it; without findings, add
the verdict output's `note`>
```

After the report, one line: the run directory (logs, `result.json`, `verdict.json`) and the
workspace check (`clean: true`, or what differs and why).

## The loop report

After `loop finish`, print the last round's report, with exactly the structure of
[the report](#the-report), but titled `# DOBERMAN LOOP AUDIT`, with these four sections right after
`## Verdict`:

```markdown
## Loop

- Rounds: <n> of <max>; stopped because <the change is ready | the rounds ran out | what is left needs your decision>
- Changes: <the files the loop changed, from summary.json `changes`>: uncommitted, for you to review and commit

| Round | Reviewed        | Verdict                            | BLOCKING | SHOULD FIX | LOW | NIT | Fixed | Deferred |
| ----- | --------------- | ---------------------------------- | -------- | ---------- | --- | --- | ----- | -------- |
| 1     | the change      | CHANGES REQUIRED                   | 0        | 3          | 7   | 2   | 11    | 1        |
| 2     | round 1's fixes | READY WITH ENVIRONMENT LIMITATIONS | 0        | 0          | 1   | 0   | —     | —        |

## Fixes Applied

### Round 1

- F1 — <title>: <what changed> (`<file>`, …; regression test `<path>`)

## Needs Your Decision

- <round>:<id> — <title>: <the decision it needs> (still open as <id> in the last round)

## Withdrawn, Resolved and Reopened

- Round <r>: <id> withdrawn — <evidence that it was not real>
- Round <r>: <round>:<id> resolved — <evidence that it no longer applies>
- Round <r>: <id> reopens <round>:<id> — <the fix that did not hold>
```

The rest is the last round's: its gates, and in BLOCKING to NITS every finding still open, each
carried one saying where it comes from (`carried from round <r> (<id>)`). `Needs Your Decision`
lists `summary.json` → `open` entries with `needsDecision`, and `Withdrawn, Resolved and Reopened`
every round's `withdrawn`, `resolved` and `reopened` entries; `None.` when a section has none. After the
report, one line: the loop directory (`loop.json`, `summary.json`, a directory per round) and the
workspace (`git status --short`: the loop's changes, nothing else).

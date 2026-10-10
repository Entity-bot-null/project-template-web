# Result and report

Two outputs: `result.json` in the run directory (machine-readable, validated by
`doberman.mjs verdict`), then the report printed to the user. Neither is written to the repository.

## Contents

- [result.json](#resultjson)
- [Statuses](#statuses)
- [How the verdict is computed](#how-the-verdict-is-computed)
- [The report](#the-report)

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
- Gate, finding and reproduction ids are unique.
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

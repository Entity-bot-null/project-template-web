# Doberman

`/doberman` is this template's pull request auditor, a Claude Code skill. It reviews the current
branch against its base the way a staff engineer, a security reviewer, a QA engineer and an SRE
would: it reconstructs the intent, reads the whole diff and the flows it touches, reproduces
suspected bugs with temporary tests, runs the template's gates, and ends with evidence-backed
findings and a merge verdict. It is read-only unless `--fix` is confirmed.

Each Golden Template has its own Doberman: the same engine and instructions, with the template's
own knowledge in `template.json` and `reference/template.md`. Outside its template it stops
(`PROJECT_TYPE = UNKNOWN`) instead of guessing gates.

## Contents

- [Use](#use)
- [How it works](#how-it-works)
- [Files](#files)
- [Keeping it in step with the template](#keeping-it-in-step-with-the-template)
- [Checking a change to Doberman](#checking-a-change-to-doberman)
- [Limits](#limits)

## Use

In Claude Code, from the repository root, on the branch to review:

```
/doberman                     the branch's changes and the gates they need
/doberman --base origin/main  another base
/doberman --diff              review and reproductions only (no gates)
/doberman --security          security review and security gates
/doberman --tests             test quality, changed-line coverage, test gates
/doberman --full              the whole repository, by risk, every gate available
/doberman --fix               after the report, offers fixes (asks first)
/doberman --help
```

Only a person can start it (`disable-model-invocation`): no agent runs it on its own. Without
commits yet, the whole tree is the change and the run is `--full`. Headless, from Git Bash on
Windows, keep the slash command from being rewritten into a path:
`MSYS_NO_PATHCONV=1 claude -p "/doberman"`.

## How it works

```
/doberman
  ├─ start      scripts/doberman.mjs start: workspace snapshot, project detection, base and
  │             merge base, files and commits, risk areas, gate plan, environment probes
  ├─ rules      CLAUDE.md, AGENTS.md, the Definition of Done, the docs of the touched areas
  ├─ intent     what, why, expected behavior, failure modes, state transitions, boundaries
  ├─ review     the diff and the flows it touches, with reference/review-checklist.md and
  │             reference/template.md (concurrency and cancellation are mandatory)
  ├─ reproduce  temporary *.doberman.spec.* tests (reference/reproduction.md)
  ├─ gates      the plan, in order, logged to the run directory; sandbox for gates that write
  ├─ coverage   scripts/doberman.mjs coverage: changed lines no test executed
  ├─ clean      scripts/doberman.mjs clean: this run's marked files, sandbox and new artifacts
  │             removed; the workspace compared with the snapshot (clean.json)
  └─ verdict    scripts/doberman.mjs verdict: result.json validated against the evidence rules
                and the gate logs, the verdict computed, then the report (reference/report.md)
```

The model judges the code; the script decides what must not depend on judgment: what project it
is, what changed, which gates apply and why, whether the workspace is as it was, and the verdict
from the findings and gate results. A failing mandatory gate is always BLOCKING; a skipped one is
an environment limitation, never a PASS; a PASS or FAIL must match the `DOBERMAN_EXIT=<code>`
line that ends the gate's log, so a gate that never finished cannot pass.

Everything a run produces outside the temporary tests goes to a run directory in the system
temporary folder (`doberman/<repo>-<time>`, or under `DOBERMAN_TMP`): `context.json`,
`snapshot.json`, `logs/`, `coverage.json`, `result.json`, `clean.json`, `verdict.json`.
`node scripts/doberman.mjs status --run <dir>` says where an interrupted run stopped;
`node scripts/doberman.mjs help` lists the commands. An option a command does not accept stops it
before it writes anything.

## Files

| File                                 | What                                                                     | Same in both templates |
| ------------------------------------ | ------------------------------------------------------------------------ | ---------------------- |
| `SKILL.md`                           | the instructions: rules, arguments, phases, gates, cleanup, verdict, fix | yes, but `description` |
| `reference/review-checklist.md`      | the review questions, false-positive protocol, severities                | yes                    |
| `reference/report.md`                | `result.json`, statuses, verdict rules, the report's structure           | yes                    |
| `reference/template.md`              | this template's stack, flows, invariants, red flags, gate notes          | no                     |
| `reference/reproduction.md`          | how to reproduce bugs with this template's test helpers                  | no                     |
| `template.json`                      | detection signals, gate catalog, services, risk areas, coverage, repro   | no                     |
| `../../../scripts/doberman.mjs`      | the engine (no dependencies; Node.js only)                               | yes                    |
| `../../../scripts/doberman.test.mjs` | the engine's tests (`node --test`)                                       | yes                    |

## Keeping it in step with the template

- **A gate added to `verify`** in `package.json` is picked up by itself; give it a name and tags
  in `template.json` → `gates`.
- **A gate that only CI runs** (a new job in `quality-gates.yml`) goes in `extraGates`, with what
  it needs (`requires`), when it applies (`when`: `always`, `paths`, `full`) and whether it writes
  files (`isolation: sandbox`).
- **A new risk area** (a module, a sensitive folder) goes in `areas`, with its focus and docs, and
  its invariants in `reference/template.md`.
- **New test helpers** belong in `reference/reproduction.md`, so reproductions use them.
- Keep the shared files identical in both templates: change them in one, copy them to the other.

## Checking a change to Doberman

1. `node --test scripts/doberman.test.mjs`: the engine's own tests (arguments, detection, git
   scopes, cleanup, verdict rules), on throwaway repositories in the temporary folder.
2. `node scripts/doberman.mjs start` from the repository root: the detection, the scope and the
   gate plan are what you expect.
3. The repository's own gates still pass with the change (format, lint, typecheck, Semgrep).
4. On a throwaway branch with a known bug, `/doberman` finds it, reproduces it, and leaves
   `git status` as it was.

## Limits

- It reviews what the repository contains: the backend of the mobile app, production
  infrastructure and real devices are outside its reach, and it says so (`UNVERIFIABLE`,
  `SKIPPED — REQUIRES …`).
- Gates run on the machine: Docker, a database, a browser, an emulator or macOS are needed for the
  gates that use them. The verdict says which ones could not run.
- It is a reviewer, not an approver: the merge decision, the approvals and CI stay as the
  template defines them.

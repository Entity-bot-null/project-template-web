# Architecture Decision Records

Significant decisions are recorded here, one file per decision, so the next person knows why
things are the way they are.

**Write one when** a choice is hard to reverse or affects several modules: a new dependency of
consequence, a data model or API shape, an infrastructure piece, a security trade-off, a deviation
from these docs.

**How:**

1. Copy [template.md](template.md) to `NNNN-short-title.md` (next number, kebab-case).
2. Fill it in; status `Proposed`.
3. Open a pull request; the discussion happens there.
4. On merge the status becomes `Accepted`. Decisions are not edited afterwards: a later ADR
   supersedes them (and the old one links to it).

The template's own baseline decisions are summarized in [docs/architecture.md](../architecture.md#key-decisions)
and explained in [docs/template/source-analysis.md](../template/source-analysis.md).

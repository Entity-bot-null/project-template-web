# Definition of Ready

A story can start when all of these hold. The feature issue template
(`.github/ISSUE_TEMPLATE/feature_request.yml`) asks for each one.

- [ ] **Value:** who it is for and why it matters are written down.
- [ ] **Acceptance criteria:** observable and testable (Given / When / Then), including errors and
      empty states.
- [ ] **Scope:** what is out of scope is stated.
- [ ] **Access:** which roles may do it, and on which records (ownership rules).
- [ ] **Contract and data:** API changes and data model changes are sketched (new routes, fields,
      tables, migrations), and breaking changes are identified.
- [ ] **Non-functional needs:** performance expectations, personal data involved, audit or
      compliance requirements, if any.
- [ ] **Dependencies:** designs, external services, credentials and other stories are available
      or scheduled.
- [ ] **Size:** small enough to finish, review and merge in a few days; otherwise split.

A story that is not ready goes back for refinement instead of starting with open questions.

Done is defined in [DEFINITION_OF_DONE.md](../DEFINITION_OF_DONE.md).

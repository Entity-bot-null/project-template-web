# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately**, never in a public issue, pull request or discussion:

- GitHub: **Security → Report a vulnerability** on this repository (private vulnerability
  reporting), or
- Email: `security@example.com` <!-- REQUIERE CONFIGURACIÓN: replace with a monitored address -->

Include what you found, how to reproduce it, the affected version or commit, and the impact you
expect. Do not access, modify or delete data that is not yours, and do not run denial-of-service
tests.

We acknowledge reports within **3 working days**, keep you informed while we fix the issue, and
credit you in the advisory if you wish. <!-- REQUIERE CONFIGURACIÓN: adjust the response times -->

## Supported versions

Only the latest release (the newest `vX.Y.Z` tag, built from `main`) receives security fixes.
Each release lists its dependencies in the SBOM attached to it (`sbom.cdx.json`).

## How this project is protected

The controls in place, their location in the code and what each deployment must configure are
documented in [docs/security.md](docs/security.md): authentication and token handling (with
refresh token theft detection), authorization (roles and ownership), CSRF/CORS/XSS defenses,
security headers, rate limiting, input and output validation, secret management, and the known
limits that each project must weigh.

Every change passes, before it can merge: static analysis (ESLint security rules, Semgrep, CodeQL
where available), an audit of the workflows themselves (zizmor), dependency advisories, the
dependency policy (registry sources, licenses, release delay, trust downgrades), secret scanning
of the tree and the history, and vulnerability scanning of the container images. OWASP ZAP scans
a running copy of the application every week. Releases carry an SBOM; published images carry
their SBOM and build provenance.

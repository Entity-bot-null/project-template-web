# 0005. Build the public site as static Astro pages, served on the app's origin

- **Status:** Proposed
- **Date:** 2026-10-20
- **Deciders:** template maintainers

## Context

Projects built from the template need a public site in front of the app: what the product is, in
the languages of its audience, findable by search engines, with the way in. Until now the web app
was the whole site, at `/`, behind the sign-in. The constraints are the template's own: one
origin for the browser (same-origin refresh cookie, no CORS, `SameSite=Strict`), a strict
Content-Security-Policy (`default-src 'self'`, no inline script or style), one image per
environment (production runs the digests staging ran), the supply-chain rules (seven-day release
delay, reviewed install scripts, permissive licenses), every gate on every app, and English and
Spanish together.

## Options

1. **Pages inside the React app** (public routes before the sign-in): no new app; but every
   visitor downloads the app's JavaScript to read a page, nothing is in the HTML for crawlers, and
   the site's look and the app's are tied together.
2. **A server-rendered framework** (Next.js, Nuxt): rich, but a Node.js server in production for
   pages that rarely change, a new runtime to patch, harden and observe, and a looser CSP.
3. **A static site generator** (Astro): pages rendered to HTML and CSS at build time, nothing
   running per request, components and TypeScript for the authors; i18n routing, sitemap and
   alternate links built in; Tailwind CSS for the styling, a dependency of the build only.
4. **A hosted site builder** or a separate domain: no code to keep; but outside the repository,
   its gates and reviews, and a second origin with its own cookies, certificates and policy.

## Decision

Option 3, as `apps/landing`: an Astro app in the workspace, styled with Tailwind CSS 4, built to
static files, in English at `/` and Spanish at `/es/` with typed dictionaries, served next to the
app on the same origin (`/` the site, `/app/` the web app, `/api` the API). The pages ship no
client JavaScript (a 0 kB budget enforces it), no inline style (stylesheets as files) and nothing
from another origin (the system's fonts), so the existing CSP needs no exception. Astro's optional
image optimizer (sharp) is not installed: its binaries are LGPL, outside the license policy, and
vector images need none.

## Consequences

- One more app under every gate: lint (with accessibility rules for `.astro` files), `astro
check`, unit and page tests with a coverage floor, a performance budget, end-to-end tests, the
  release version. `pnpm dev` runs it with the others.
- Moving the web app under `/app/` is a follow-up change: the router's basename, the build's base,
  the links in emails and the web server's routes.
- The public pages are absolute-URL aware (canonical, sitemap) while the image is built once:
  the public origin is set where the site is served, not where it is built.
- Authors write every text twice, in the same change; the build refuses a page with a text missing
  in one language.
- Wrong if: the site needs per-request content (then a server, or build-time data with a rebuild
  per change), or a client-side feature large enough that the 0 kB budget is constantly raised.

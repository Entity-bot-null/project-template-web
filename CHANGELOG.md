# Changelog

## [2.1.0](https://github.com/Entity-bot-null/project-template-web/compare/v2.0.0...v2.1.0) (2026-10-25)


### Features

* **doberman:** audit in rounds that fix what each one finds (--loop) ([4cf4df1](https://github.com/Entity-bot-null/project-template-web/commit/4cf4df154779b44705115b776c3ef8832318621d))


### Bug fixes

* close the session, email change, outbox and gate gaps the v2.0.0 audit found ([5909704](https://github.com/Entity-bot-null/project-template-web/commit/5909704cd7c9f91fd66f2056ba53fd4877995fe8))

## [2.0.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.2.1...v2.0.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **deploy:** run PostgreSQL and Redis on the server, and Redis in development ([#62](https://github.com/Entity-bot-null/project-template-web/issues/62))
* **web:** serve the landing at / and the web app under /app/ ([#61](https://github.com/Entity-bot-null/project-template-web/issues/61))

### Features

* **deploy:** run PostgreSQL and Redis on the server, and Redis in development ([#62](https://github.com/Entity-bot-null/project-template-web/issues/62)) ([4cec3ab](https://github.com/Entity-bot-null/project-template-web/commit/4cec3ab69252fb96584959e7e2c40328f2f4ca82))
* **landing:** add the public site in English and Spanish ([#60](https://github.com/Entity-bot-null/project-template-web/issues/60)) ([2227f68](https://github.com/Entity-bot-null/project-template-web/commit/2227f683dc0c458e211f825d22f885bdab4dd05d))
* **web:** serve the landing at / and the web app under /app/ ([#61](https://github.com/Entity-bot-null/project-template-web/issues/61)) ([07317e0](https://github.com/Entity-bot-null/project-template-web/commit/07317e05035b27ac5ea57174f0256f30ab2d52ad))


### Bug fixes

* **api:** link the migration engine to Debian's OpenSSL, and keep Prisma's CLI offline ([#63](https://github.com/Entity-bot-null/project-template-web/issues/63)) ([80ba14a](https://github.com/Entity-bot-null/project-template-web/commit/80ba14a9d74e6e4da6dca96fa45cda7626db375e))

## [1.2.1](https://github.com/Entity-bot-null/project-template-web/compare/v1.2.0...v1.2.1) (2026-10-20)


### Bug fixes

* **security:** keep Doberman's run directories private ([#58](https://github.com/Entity-bot-null/project-template-web/issues/58)) ([f0c83f8](https://github.com/Entity-bot-null/project-template-web/commit/f0c83f853748710668f62d1af6543b177a0c9861))

## [1.2.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.2...v1.2.0) (2026-10-13)


### Features

* **account:** change of email confirmed from the new address, undoable from the previous one ([#43](https://github.com/Entity-bot-null/project-template-web/issues/43)) ([a12e734](https://github.com/Entity-bot-null/project-template-web/commit/a12e734417c582a1d9aa1c1841c2098ca200e51a))
* **api:** transactional email outbox over SMTP, with Mailpit for development and CI ([#40](https://github.com/Entity-bot-null/project-template-web/issues/40)) ([04ae24e](https://github.com/Entity-bot-null/project-template-web/commit/04ae24ecde2cb81c4bbbaa81703441133c8a1df1))
* **auth:** optional public sign-up, confirmed by an emailed link and the chosen password ([#42](https://github.com/Entity-bot-null/project-template-web/issues/42)) ([b821bc4](https://github.com/Entity-bot-null/project-template-web/commit/b821bc4e1f021f21e6070d613c833f39f5d0cb31))
* **auth:** password recovery by email link and password change, ending other sessions at once ([#41](https://github.com/Entity-bot-null/project-template-web/issues/41)) ([11103e6](https://github.com/Entity-bot-null/project-template-web/commit/11103e67edcbfcc5aa1182535cc15fca0aac117f))
* **dev:** the app's URLs in a box under the dev servers' logs, database on port 5442 ([#39](https://github.com/Entity-bot-null/project-template-web/issues/39)) ([7a2c258](https://github.com/Entity-bot-null/project-template-web/commit/7a2c258f767d2783b81e9fb31276b8c4dc72a561))
* **invitations:** administrators invite people to create an account with a role ([#44](https://github.com/Entity-bot-null/project-template-web/issues/44)) ([e556f90](https://github.com/Entity-bot-null/project-template-web/commit/e556f90da796eda06ee7cba94496e52029ddaef3))


### Bug fixes

* **ci:** pull service containers and image base images through the mirror ([#37](https://github.com/Entity-bot-null/project-template-web/issues/37)) ([6c3d346](https://github.com/Entity-bot-null/project-template-web/commit/6c3d346ff4c8421f794d2771667ccebed351fde6))
* **security:** findings of the independent review, audit and penetration test ([#45](https://github.com/Entity-bot-null/project-template-web/issues/45)) ([edc2c9d](https://github.com/Entity-bot-null/project-template-web/commit/edc2c9df9cebb92a87e406f387ece5dcb3f569e8))

## [1.1.2](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.1...v1.1.2) (2026-10-12)


### Bug fixes

* **ci:** pull ECR Public tool images through the Docker Hub mirror ([#35](https://github.com/Entity-bot-null/project-template-web/issues/35)) ([770473c](https://github.com/Entity-bot-null/project-template-web/commit/770473ca55abd9a4abd415ebdb9f9da33d1589f3))

## [1.1.1](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.0...v1.1.1) (2026-10-11)


### Bug fixes

* **api:** keep session changes serialized under any isolation level and in manual revocations ([#27](https://github.com/Entity-bot-null/project-template-web/issues/27)) ([314e8fc](https://github.com/Entity-bot-null/project-template-web/commit/314e8fc992b9807eaf2589d7c84ea34c38d2efa7))
* **db:** refuse a database whose applied migrations were edited, and contract steps without a reason ([#30](https://github.com/Entity-bot-null/project-template-web/issues/30)) ([fd94e60](https://github.com/Entity-bot-null/project-template-web/commit/fd94e60433fcd15f07a906e6a89b290efaa7e083))
* **deploy:** one deployment or rollback at a time on the server, readiness after a rollback ([#25](https://github.com/Entity-bot-null/project-template-web/issues/25)) ([a02b87b](https://github.com/Entity-bot-null/project-template-web/commit/a02b87b962724ad2409e46a3025773f132509b4a))
* **web:** keep a refresh alive across a reload so its rotated cookie lands ([#28](https://github.com/Entity-bot-null/project-template-web/issues/28)) ([146422d](https://github.com/Entity-bot-null/project-template-web/commit/146422d96bb33b77df68dd5690224d5cb53d8b6a))
* **web:** pass the browser's Host through the dev proxy, and document the one-origin topology ([#29](https://github.com/Entity-bot-null/project-template-web/issues/29)) ([da2a5c4](https://github.com/Entity-bot-null/project-template-web/commit/da2a5c415e346ade48c45e545a1a53d8ddb25f4d))

## [1.1.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.0.0...v1.1.0) (2026-10-11)


### Features

* **api:** record the Web Vitals the web app reports ([82445a7](https://github.com/Entity-bot-null/project-template-web/commit/82445a7a228de6065e2085fc55f7ae2208a057b8))
* **infra:** provision the VPS target on DigitalOcean with Terraform ([44f6cbb](https://github.com/Entity-bot-null/project-template-web/commit/44f6cbbf94bff231beccccf028f9e5e8a286013a))
* **observability:** add the Web Vitals dashboard, alerts and docs ([82445a7](https://github.com/Entity-bot-null/project-template-web/commit/82445a7a228de6065e2085fc55f7ae2208a057b8))
* **observability:** dashboards, alerts and SLOs as code ([#10](https://github.com/Entity-bot-null/project-template-web/issues/10)) ([a6201bf](https://github.com/Entity-bot-null/project-template-web/commit/a6201bf61c22e99fae3f4c72dc61c0082d344e61))
* **web:** report Web Vitals from real page loads ([82445a7](https://github.com/Entity-bot-null/project-template-web/commit/82445a7a228de6065e2085fc55f7ae2208a057b8))


### Bug fixes

* **api:** apply auth limits on top of the global one and check origins ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **api:** count a lost database connection as a database failure ([b42c24a](https://github.com/Entity-bot-null/project-template-web/commit/b42c24a607c9e9f328552d46da1608adc5201b1e))
* **api:** keep external calls under the client's base path ([7024309](https://github.com/Entity-bot-null/project-template-web/commit/7024309007e7ece3ab80fdd4dad996c7b2bce2ba))
* **api:** keep pnpm dev running while a one-off command builds the API ([d0b1a98](https://github.com/Entity-bot-null/project-template-web/commit/d0b1a984da077ee53a351fd467d48c5ce5221d2b))
* **api:** log requests whose connection closes before the response ([7024309](https://github.com/Entity-bot-null/project-template-web/commit/7024309007e7ece3ab80fdd4dad996c7b2bce2ba))
* **api:** tell an idempotency claim in progress from a processed one ([8b68195](https://github.com/Entity-bot-null/project-template-web/commit/8b6819598789325c08a641b460c2618ea40f4822))
* **ci:** retry a tool image pull that a registry rate-limited ([d3e1573](https://github.com/Entity-bot-null/project-template-web/commit/d3e1573298c9edbcac5537281b7c3315bd450156))
* **deploy:** deploy the digests the run built and scanned, never a registry tag ([8b68195](https://github.com/Entity-bot-null/project-template-web/commit/8b6819598789325c08a641b460c2618ea40f4822))
* **deploy:** grant the migrator role before creating the app database ([44f6cbb](https://github.com/Entity-bot-null/project-template-web/commit/44f6cbbf94bff231beccccf028f9e5e8a286013a))
* **deploy:** reach a database whose certificate the provider's CA signs ([44f6cbb](https://github.com/Entity-bot-null/project-template-web/commit/44f6cbbf94bff231beccccf028f9e5e8a286013a))
* **deps:** evaluate SPDX expressions and expire release-age exemptions ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **images:** apply the day's operating system fixes, not a cached upgrade ([8b68195](https://github.com/Entity-bot-null/project-template-web/commit/8b6819598789325c08a641b460c2618ea40f4822))
* **observability:** identify the process, not the machine, in exported telemetry ([b42c24a](https://github.com/Entity-bot-null/project-template-web/commit/b42c24a607c9e9f328552d46da1608adc5201b1e))
* **observability:** keep the exporters' own requests out of the outgoing request metrics ([b42c24a](https://github.com/Entity-bot-null/project-template-web/commit/b42c24a607c9e9f328552d46da1608adc5201b1e))
* **observability:** leave the Web Vitals beacons out of the API SLOs ([1ef6024](https://github.com/Entity-bot-null/project-template-web/commit/1ef6024c6c5ffefc6086e0edea29b7ec94f30205))
* **observability:** redact span events and status messages ([7024309](https://github.com/Entity-bot-null/project-template-web/commit/7024309007e7ece3ab80fdd4dad996c7b2bce2ba))
* **observability:** redact string arrays and mask values under sensitive names in spans ([b42c24a](https://github.com/Entity-bot-null/project-template-web/commit/b42c24a607c9e9f328552d46da1608adc5201b1e))
* **release:** bump the OpenAPI document's version with the release ([7bb727f](https://github.com/Entity-bot-null/project-template-web/commit/7bb727f85d6e9738b89245c076b2aef610ceac51))
* **sast:** scan the nginx template under the name nginx renders it to ([8b68195](https://github.com/Entity-bot-null/project-template-web/commit/8b6819598789325c08a641b460c2618ea40f4822))
* **web:** count each Web Vital of a page load once ([1ef6024](https://github.com/Entity-bot-null/project-template-web/commit/1ef6024c6c5ffefc6086e0edea29b7ec94f30205))
* **web:** fail a success answer that is not JSON as not the API's ([d0b1a98](https://github.com/Entity-bot-null/project-template-web/commit/d0b1a984da077ee53a351fd467d48c5ce5221d2b))
* **web:** fall back to fetch when sendBeacon throws ([1ef6024](https://github.com/Entity-bot-null/project-template-web/commit/1ef6024c6c5ffefc6086e0edea29b7ec94f30205))
* **web:** let a sign-in on its way end the old session before a retried sign-out ([8b68195](https://github.com/Entity-bot-null/project-template-web/commit/8b6819598789325c08a641b460c2618ea40f4822))
* **web:** reject malformed success answers and bound the refresh ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **web:** take turns with other tabs for sign-in and logout, and ride out a 429 at boot ([#23](https://github.com/Entity-bot-null/project-template-web/issues/23)) ([25eba84](https://github.com/Entity-bot-null/project-template-web/commit/25eba84aa2e76a978025c6c65bde33d1d577877b))

## 1.0.0 (2026-10-10)

First public release of the template.

# Changelog

## [2.1.0](https://github.com/Entity-bot-null/project-template-web/compare/v2.0.0...v2.1.0) (2026-10-25)


### Features

* **doberman:** audit in rounds that fix what each one finds (--loop) ([3ec1c84](https://github.com/Entity-bot-null/project-template-web/commit/3ec1c8490172abed71d845e5753844a1543ab76d))


### Bug fixes

* close the session, email change, outbox and gate gaps the v2.0.0 audit found ([f9a7150](https://github.com/Entity-bot-null/project-template-web/commit/f9a7150863ee12d58223863f5f025525cf7d8e69))

## [2.0.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.2.1...v2.0.0) (2026-10-21)


### ⚠ BREAKING CHANGES

* **deploy:** run PostgreSQL and Redis on the server, and Redis in development ([#62](https://github.com/Entity-bot-null/project-template-web/issues/62))
* **web:** serve the landing at / and the web app under /app/ ([#61](https://github.com/Entity-bot-null/project-template-web/issues/61))

### Features

* **deploy:** run PostgreSQL and Redis on the server, and Redis in development ([#62](https://github.com/Entity-bot-null/project-template-web/issues/62)) ([1a11861](https://github.com/Entity-bot-null/project-template-web/commit/1a118612c5c8dec963b547f4480980975c956776))
* **landing:** add the public site in English and Spanish ([#60](https://github.com/Entity-bot-null/project-template-web/issues/60)) ([3881850](https://github.com/Entity-bot-null/project-template-web/commit/3881850510fc69dd44199ee626727861af0d0030))
* **web:** serve the landing at / and the web app under /app/ ([#61](https://github.com/Entity-bot-null/project-template-web/issues/61)) ([a33a98d](https://github.com/Entity-bot-null/project-template-web/commit/a33a98da9b69939f1dfd6bc7fcf2dbf15ce49398))


### Bug fixes

* **api:** link the migration engine to Debian's OpenSSL, and keep Prisma's CLI offline ([#63](https://github.com/Entity-bot-null/project-template-web/issues/63)) ([e2e30aa](https://github.com/Entity-bot-null/project-template-web/commit/e2e30aa29ba7a00fd03f80fe6a8fdc0d6c4e3db6))

## [1.2.1](https://github.com/Entity-bot-null/project-template-web/compare/v1.2.0...v1.2.1) (2026-10-20)


### Bug fixes

* **security:** keep Doberman's run directories private ([#58](https://github.com/Entity-bot-null/project-template-web/issues/58)) ([06b1151](https://github.com/Entity-bot-null/project-template-web/commit/06b1151cc8a68b63b99b2b5b04c992d32dde6205))

## [1.2.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.2...v1.2.0) (2026-10-13)


### Features

* **account:** change of email confirmed from the new address, undoable from the previous one ([#43](https://github.com/Entity-bot-null/project-template-web/issues/43)) ([9a2e905](https://github.com/Entity-bot-null/project-template-web/commit/9a2e905d9f7d66b4b431ec085e521593ca4903bd))
* **api:** transactional email outbox over SMTP, with Mailpit for development and CI ([#40](https://github.com/Entity-bot-null/project-template-web/issues/40)) ([d2601d6](https://github.com/Entity-bot-null/project-template-web/commit/d2601d62efa3cd5db3bc788cb9c840ea88221267))
* **auth:** optional public sign-up, confirmed by an emailed link and the chosen password ([#42](https://github.com/Entity-bot-null/project-template-web/issues/42)) ([6a39042](https://github.com/Entity-bot-null/project-template-web/commit/6a39042102c22cb8e46ed5974b0313619d2fbf61))
* **auth:** password recovery by email link and password change, ending other sessions at once ([#41](https://github.com/Entity-bot-null/project-template-web/issues/41)) ([4c545a0](https://github.com/Entity-bot-null/project-template-web/commit/4c545a0c34082ecf1a24f4773ce911a073fb2ba8))
* **dev:** the app's URLs in a box under the dev servers' logs, database on port 5442 ([#39](https://github.com/Entity-bot-null/project-template-web/issues/39)) ([65ca045](https://github.com/Entity-bot-null/project-template-web/commit/65ca045ec8c016d28300c32d692976967853afd2))
* **invitations:** administrators invite people to create an account with a role ([#44](https://github.com/Entity-bot-null/project-template-web/issues/44)) ([ddfe4c4](https://github.com/Entity-bot-null/project-template-web/commit/ddfe4c4e8f7db769a0a12c40898cc2425a88cbe9))


### Bug fixes

* **ci:** pull service containers and image base images through the mirror ([#37](https://github.com/Entity-bot-null/project-template-web/issues/37)) ([c30ac29](https://github.com/Entity-bot-null/project-template-web/commit/c30ac29edb2fb3ef8653f6bfdc99c93a20be9ca0))
* **security:** findings of the independent review, audit and penetration test ([#45](https://github.com/Entity-bot-null/project-template-web/issues/45)) ([4de700e](https://github.com/Entity-bot-null/project-template-web/commit/4de700ea415d661e999d6ffbb62cbc114595eda9))

## [1.1.2](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.1...v1.1.2) (2026-10-12)


### Bug fixes

* **ci:** pull ECR Public tool images through the Docker Hub mirror ([#35](https://github.com/Entity-bot-null/project-template-web/issues/35)) ([e74fad8](https://github.com/Entity-bot-null/project-template-web/commit/e74fad87a3a3ea0fd82cc86905f8d463594b7fdb))

## [1.1.1](https://github.com/Entity-bot-null/project-template-web/compare/v1.1.0...v1.1.1) (2026-10-11)


### Bug fixes

* **api:** keep session changes serialized under any isolation level and in manual revocations ([#27](https://github.com/Entity-bot-null/project-template-web/issues/27)) ([2ac1a2f](https://github.com/Entity-bot-null/project-template-web/commit/2ac1a2f9c7ee63d6e9dfcd26598499a6b044e09f))
* **db:** refuse a database whose applied migrations were edited, and contract steps without a reason ([#30](https://github.com/Entity-bot-null/project-template-web/issues/30)) ([3e6d3b1](https://github.com/Entity-bot-null/project-template-web/commit/3e6d3b16f08f90724148fee479549e2d76c2dd60))
* **deploy:** one deployment or rollback at a time on the server, readiness after a rollback ([#25](https://github.com/Entity-bot-null/project-template-web/issues/25)) ([f3cc3e6](https://github.com/Entity-bot-null/project-template-web/commit/f3cc3e6f0071ab8942086bb93083cd1a827853d7))
* **web:** keep a refresh alive across a reload so its rotated cookie lands ([#28](https://github.com/Entity-bot-null/project-template-web/issues/28)) ([fe00d90](https://github.com/Entity-bot-null/project-template-web/commit/fe00d902eeaf5483d33088c357e8a4598046ad1d))
* **web:** pass the browser's Host through the dev proxy, and document the one-origin topology ([#29](https://github.com/Entity-bot-null/project-template-web/issues/29)) ([0f38e7e](https://github.com/Entity-bot-null/project-template-web/commit/0f38e7efb65b1b7ec6d2d3813426f1e7569e6990))

## [1.1.0](https://github.com/Entity-bot-null/project-template-web/compare/v1.0.0...v1.1.0) (2026-10-11)


### Features

* **api:** record the Web Vitals the web app reports ([f1edf78](https://github.com/Entity-bot-null/project-template-web/commit/f1edf78005b3593bbd6fc5b6d8a6004390007879))
* **infra:** provision the VPS target on DigitalOcean with Terraform ([7bc0bcb](https://github.com/Entity-bot-null/project-template-web/commit/7bc0bcba9052bb8da91f6f127168f852ea679fdb))
* **observability:** add the Web Vitals dashboard, alerts and docs ([f1edf78](https://github.com/Entity-bot-null/project-template-web/commit/f1edf78005b3593bbd6fc5b6d8a6004390007879))
* **observability:** dashboards, alerts and SLOs as code ([#10](https://github.com/Entity-bot-null/project-template-web/issues/10)) ([b5b37e4](https://github.com/Entity-bot-null/project-template-web/commit/b5b37e4ffb2681c9d5082aeb04fabadff99906d3))
* **web:** report Web Vitals from real page loads ([f1edf78](https://github.com/Entity-bot-null/project-template-web/commit/f1edf78005b3593bbd6fc5b6d8a6004390007879))


### Bug fixes

* **api:** apply auth limits on top of the global one and check origins ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **api:** count a lost database connection as a database failure ([13ac681](https://github.com/Entity-bot-null/project-template-web/commit/13ac681e6b45368552adb7d82eadb64520198d8d))
* **api:** keep external calls under the client's base path ([f21a0dc](https://github.com/Entity-bot-null/project-template-web/commit/f21a0dc67ccfeb4bfc9c7a653e14785bd23e166b))
* **api:** keep pnpm dev running while a one-off command builds the API ([b4cf390](https://github.com/Entity-bot-null/project-template-web/commit/b4cf3908aeb6dfb19a86dc08b4d3a059ea1988f5))
* **api:** log requests whose connection closes before the response ([f21a0dc](https://github.com/Entity-bot-null/project-template-web/commit/f21a0dc67ccfeb4bfc9c7a653e14785bd23e166b))
* **api:** tell an idempotency claim in progress from a processed one ([ecc3120](https://github.com/Entity-bot-null/project-template-web/commit/ecc3120ad78073e9cc97280a05bc386787c2de50))
* **ci:** retry a tool image pull that a registry rate-limited ([a1fe715](https://github.com/Entity-bot-null/project-template-web/commit/a1fe71578def01aff09051b98bcf29278eb706e0))
* **deploy:** deploy the digests the run built and scanned, never a registry tag ([ecc3120](https://github.com/Entity-bot-null/project-template-web/commit/ecc3120ad78073e9cc97280a05bc386787c2de50))
* **deploy:** grant the migrator role before creating the app database ([7bc0bcb](https://github.com/Entity-bot-null/project-template-web/commit/7bc0bcba9052bb8da91f6f127168f852ea679fdb))
* **deploy:** reach a database whose certificate the provider's CA signs ([7bc0bcb](https://github.com/Entity-bot-null/project-template-web/commit/7bc0bcba9052bb8da91f6f127168f852ea679fdb))
* **deps:** evaluate SPDX expressions and expire release-age exemptions ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **images:** apply the day's operating system fixes, not a cached upgrade ([ecc3120](https://github.com/Entity-bot-null/project-template-web/commit/ecc3120ad78073e9cc97280a05bc386787c2de50))
* **observability:** identify the process, not the machine, in exported telemetry ([13ac681](https://github.com/Entity-bot-null/project-template-web/commit/13ac681e6b45368552adb7d82eadb64520198d8d))
* **observability:** keep the exporters' own requests out of the outgoing request metrics ([13ac681](https://github.com/Entity-bot-null/project-template-web/commit/13ac681e6b45368552adb7d82eadb64520198d8d))
* **observability:** leave the Web Vitals beacons out of the API SLOs ([861a1d7](https://github.com/Entity-bot-null/project-template-web/commit/861a1d74a76d4c1d4f1aa1da0028760d82e340ca))
* **observability:** redact span events and status messages ([f21a0dc](https://github.com/Entity-bot-null/project-template-web/commit/f21a0dc67ccfeb4bfc9c7a653e14785bd23e166b))
* **observability:** redact string arrays and mask values under sensitive names in spans ([13ac681](https://github.com/Entity-bot-null/project-template-web/commit/13ac681e6b45368552adb7d82eadb64520198d8d))
* **release:** bump the OpenAPI document's version with the release ([2296975](https://github.com/Entity-bot-null/project-template-web/commit/2296975c8d442f4abfdf58ab255f9e71068610fa))
* **sast:** scan the nginx template under the name nginx renders it to ([ecc3120](https://github.com/Entity-bot-null/project-template-web/commit/ecc3120ad78073e9cc97280a05bc386787c2de50))
* **web:** count each Web Vital of a page load once ([861a1d7](https://github.com/Entity-bot-null/project-template-web/commit/861a1d74a76d4c1d4f1aa1da0028760d82e340ca))
* **web:** fail a success answer that is not JSON as not the API's ([b4cf390](https://github.com/Entity-bot-null/project-template-web/commit/b4cf3908aeb6dfb19a86dc08b4d3a059ea1988f5))
* **web:** fall back to fetch when sendBeacon throws ([861a1d7](https://github.com/Entity-bot-null/project-template-web/commit/861a1d74a76d4c1d4f1aa1da0028760d82e340ca))
* **web:** let a sign-in on its way end the old session before a retried sign-out ([ecc3120](https://github.com/Entity-bot-null/project-template-web/commit/ecc3120ad78073e9cc97280a05bc386787c2de50))
* **web:** reject malformed success answers and bound the refresh ([#5](https://github.com/Entity-bot-null/project-template-web/issues/5)) ([2eb88bd](https://github.com/Entity-bot-null/project-template-web/commit/2eb88bdc81252d8928c56f3dbd30b004d3f81f5a))
* **web:** take turns with other tabs for sign-in and logout, and ride out a 429 at boot ([#23](https://github.com/Entity-bot-null/project-template-web/issues/23)) ([945c6fb](https://github.com/Entity-bot-null/project-template-web/commit/945c6fb5e671abff59efdd85405cf520b88061d5))

## 1.0.0 (2026-10-10)

First public release of the template.

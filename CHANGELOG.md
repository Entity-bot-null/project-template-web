# Changelog

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

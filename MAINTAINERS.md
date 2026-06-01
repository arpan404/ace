# Maintainers

ace is maintained by:

- [@arpan404](https://github.com/arpan404)

## Maintainer Responsibilities

- Keep `main` releasable.
- Prioritize security, reliability, performance, and predictable failure behavior.
- Review protocol, provider runtime, release, and desktop changes carefully.
- Ask contributors to split or narrow changes when review risk is too high.
- Keep automation and labels understandable enough that contributors can predict review flow.

## Review Expectations

High-risk changes should receive explicit maintainer attention before merge:

- shared contracts or WebSocket protocol changes
- provider runtime, session, orchestration, or reconnect behavior
- auth, token handling, relay, browser, filesystem, or process execution changes
- desktop updater, signing, packaging, or release automation
- broad dependency swaps or large refactors

## Release Authority

Only maintainers should publish desktop releases, update signing configuration, or change release automation secrets.

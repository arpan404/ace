# Integration train 2

## Merge decisions

- #44: retain train 1's daemon options and service/resource registries. Register files through daemon/socket factories; register relay transport startup at the authenticated transport boundary. Socket services now have authentication and binary hooks. Preserve preview, diagnostics, notifications, models, engine, settings, context, review and history.
- #44: use bounded fragmented relay binary messages and retain the preview `receiveBinary` interface over the same framing. Both consumers share encryption, rekeying and queue bounds.
- #44: retain indexed text-stream range reads and paging while adding raw byte export and blob/output metadata. Preserve both workspace-change and update-blocker indexes.
- Keep package dependencies, protocol exports and NOTICE attribution from every head. Regenerate lockfiles from the current integration branch with `bun install`.
- Replace incoming process manifests with `.process.test.ts` filenames. Preserve all-package externalization in the process fixture build so native bindings, CommonJS dependencies and worker URLs resolve normally.

Each feature merge is typechecked before its commit. Full runtime validation follows the final merge.

- #46: move catalog startup and socket requests to service factories. Keep trusted runtime/execution event subscriptions and shutdown cancellation. Retain the stronger typed workspace lookup instead of coercing database values to strings. Migrate command I/O suites by filename.
- #25: register the account registry and bounded authenticated account requests as services. Preserve CLI argument normalization and account subcommands. Single-provider discovery now owns the shared probe logic, with train 1's Antigravity read-only probe retained. Keep filename-based test projects and classify account I/O tests.

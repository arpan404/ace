# OpenCode 2.4.2 model catalog sample

Recorded on 2026-11-25 from the installed OpenCode `v2.4.2` (no session, no prompt): the
`GET /api/model` reply for one location, trimmed to four models and to the fields ace reads
(`id`, `modelID`, `providerID`, `name`, `capabilities`, `variants`, `limit`, `status`,
`enabled`, `time`). `cost` is emptied and response headers, auth and account data are removed.

The full reply also carries `package`, `settings`, `compatibility`, `canonical`, `type` and
`experimental`; ace keeps those in `raw` and none of them name a reasoning level. Reasoning
levels are `variants[].id` in the order the server lists them, with the provider's request
spelling in `variants[].settings.reasoningEffort`.

`opencode models` lists model IDs only, and its `--verbose` flag no longer exists, so this
payload is the only source of a model's effort levels on 2.4.2.

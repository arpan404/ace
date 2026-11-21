<!-- spec:begin header -->
# Spade Agent Format 1.0: Package

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `package`, version 1.0, of the [Spade Agent Format](README.md) 1.0. The folder, its limits and `bot.json` version 3: every field, what is refused, how unknown fields are kept and grant nothing.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

## The folder

A package is a folder. Its manifest is `bot.json` at the top; every other file it names is a
path inside the folder: scenario tests under `tests/`, cards under `cards/`, each panel's page at
`panels/<id>/index.html`, contract schema files under `contracts/`. A reader MUST refuse a
manifest that names a file outside these places, and a runtime MUST NOT run anything from the
folder: a package carries data and words, never code it executes.

The folder's identity is not in it. A package's publisher, name as listed, version and content
hash are the signed version manifest's ([distribution](distribution.md)); the manifest's own
`version` is the format's number.

## The manifest

`bot.json` is a JSON object. Its `format` MUST be `"spade-bot"` and its `version` the number `3`.
Version 3 knows these fields:

<!-- spec:begin fields -->
| Field | What it is |
| --- | --- |
| `$schema` | The address of the format's JSON Schema, for editors; it changes nothing a runtime does. |
| `format` | MUST be `"spade-bot"`. |
| `version` | The format's number, `3`. A string is refused: a package's own version is the signed version manifest's. |
| `spec` | The Spade Agent Format version it was written for, like `"1.0"`; missing reads as `1.0`. A reader MUST read every minor version of its major and refuse another major. |
| `requires` | `{runtime, spade?}`: the major version of the `runtime` part it needs, as a string, and the oldest runtime build whose additions it uses. |
| `name` | The bot's name, required. |
| `blurb` | One line on what it does. |
| `task` | What the bot is for, in words, as its standing instruction. |
| `face` | How the bot looks: a character, never a picture. |
| `style` | `{accent}`: one colour, like `#2F7BEA`. |
| `personality` | `{tone, humour, emoji}`. |
| `model` | `fast` or `capable` (the default): a kind of model, never a model of its own. |
| `uses` | The `runtime` modules the bot uses; its tools are narrowed to them. Missing means every module. |
| `triggers` | What starts the bot's work (below). Missing means `message`. |
| `skills` | Skills by reference. |
| `plugins` | Plugins by reference, which the person accepts on their own. |
| `needs` | `{tools?, connectors?}`: built-in tools and connected apps it needs. |
| `effects` | What it may do beyond reading and its own things: the ceiling ([effects](effects.md)). |
| `limits` | `spend_alert {usd_per_day}`, `workers_at_once`, `workspace_mb`: an alert line and bounds, never a stop. |
| `tests` | Scenario files in the package ([distribution](distribution.md)). |
| `notes` | Starting notes the bot keeps. |
| `pricing` | `{kind: "free"}`; missing reads as free, and any other price is refused. |
| `surfaces` | Cards and panels ([surfaces](surfaces.md)). |
| `contracts` | Typed calls other bots of the person may make to it ([contracts](contracts.md)). |
| `code` | WebAssembly components it ships under `code/`, each built for Spade's world ([code](code.md)). |
<!-- spec:end fields -->

A version 2 manifest knows these fields; a reader MAY install it as a copy the person owns,
unlinked from its package, with its `routines` read as schedule triggers:

<!-- spec:begin v2 -->
`personality`, `format`, `version`, `name`, `blurb`, `task`, `face`, `model`, `routines`, `tools`, `skills`, `plugins`, `needs`, `notes`.
<!-- spec:end v2 -->

### Unknown fields

A field the reader doesn't know MUST be kept, by name, and MUST grant nothing: every
capability comes from a field this part names. A reader SHOULD show such fields to the person as
not used by this runtime.

### Refused whole

A reader MUST refuse the whole manifest, never a part of it, when it holds:

- anything named or shaped like a key, token or secret, anywhere in it;
- a field that claims identity or runs something:

<!-- spec:begin refused -->
- **Identity**, which is the signed version manifest's alone: `publisher`, `signature`, `signatures`, `signed`, `hash`, `package`.
- **Executions**, which are plugins', never a package's: `mcpServers`, `mcp_servers`, `mcp`, `servers`, `hooks`, `executions`, `commands`, `command`.
<!-- spec:end refused -->

- the `credential` effect, or a grant the `effects` part doesn't allow;
- any price but free;
- `requires.runtime` that isn't a string naming a major version the reader serves, or
  `requires.spade` newer than the runtime. The refusal says the package needs a newer runtime.

### Bounds

<!-- spec:begin bounds -->
| What | Bound |
| --- | --- |
| `name` | at most 80 characters |
| `blurb` | at most 300 characters |
| `triggers` | at most 40 |
| routines (schedule, event and webhook triggers) | at most 32, each name once |
| a routine's `name` | 1 to 60 characters |
| a routine's `instruction` | 1 to 4,000 characters |
| `effects` | at most 32 |
| an effect's `why` | 1 to 500 characters |
| an effect's `hosts` | 1 to 32 |
| `needs.tools` | at most 64 |
| `skills`, `plugins` | at most 64 each |
| `tests` | at most 64 |
| `notes` | at most 50, each at most 2,000 characters |
| `limits.spend_alert.usd_per_day` | 0 to 10,000 |
| `limits.workers_at_once` | 1 to 64 |
| `limits.workspace_mb` | 1 to 1,000,000 |
<!-- spec:end bounds -->

## Modules

`uses` names the `runtime` part's modules. A runtime MUST narrow the bot's tools to the modules
it uses (its conversation and reply excepted), and MUST refuse a package that uses a module it
doesn't have, by the module's name.

<!-- spec:begin modules -->
| Module | What it holds |
| --- | --- |
| `task` | The bot's goal, plan and where its task stands; its own task and face. |
| `memory` | Notes, the knowledge base, past episodes and the conversation's history. |
| `files` | The bot's workspace, its sandboxed shell and the services it owns. |
| `web` | Searching and reading the web. |
| `apps` | The person's connected apps and allowed plugins. Their own tools are offered deferred and gated, and their output is untrusted; their names are the apps', not part of this API. |
| `agents` | Other bots, clubs, workers, helpers and ace's coding agents. |
| `ui` | What the person sees besides the reply: questions, images, cards and the state of its package's panels. |
| `schedule` | Routines, wakes and waits. |
| `devices` | ace's browser, screen and simulators, and devices named with @, through ace. |
| `outward` | Pushes, comments and messages with the person's own sign-ins. |
| `notify` | Proactive notices to the person, under their quiet hours, do not disturb, interruption budget and each bot's notification switch; what waits goes into the morning brief. A bot sends at most 3 an hour (more wait for the brief) and 12 a day (more are refused). The words are the bot's, shown as plain text. |
<!-- spec:end modules -->

## Triggers

`triggers` is a list; missing, it is one `message` trigger. Each has a `kind`:

- `message`: the person writes to the bot.
- `mention {in}`: the bot is mentioned in `threads`, `clubs` or both (the default).
- `schedule {name, instruction, schedule}`: a routine on a schedule.
- `event {name, instruction, event}`: a routine on a runtime event.
- `webhook {name, instruction}`: a routine on a call to the bot's webhook address.

A kind the reader doesn't know is kept and not used. Each routine's `name` is its own, so an
update finds it by name. A runtime MUST make schedule, event and webhook triggers paused at
install, and start only the ones the person turned on.

<!-- spec:begin triggers -->
An `event` trigger names one of: `thread.finished` (when an agent thread finishes), `thread.failed` (when an agent thread fails), `thread.needs_you` (when an agent thread needs you).
<!-- spec:end triggers -->

## Rules

Every refusal names its rule, by an id that never changes, so a conformance case matches a
refusal by its rule and never by its words. A reader's words are its own.

<!-- spec:begin rules -->
From [`conformance/rules.json`](conformance/rules.json).

| Rule | A reader MUST refuse | The JSON Schema decides it |
| --- | --- | --- |
| `package.secret` | Something in the manifest is named or shaped like a key, token or secret. | no |
| `package.not-object` | bot.json isn't a JSON object. | yes |
| `package.format` | `format` isn't `"spade-bot"`. | yes |
| `package.version` | `version` isn't the format's number this reader reads, or is a string. | yes |
| `package.spec` | `spec` isn't a version of the Spade Agent Format this reader serves (`1.<minor>`). | yes |
| `package.identity` | A field claims identity, which is the signed version manifest's alone. | yes |
| `package.execution` | A field carries executions (servers, hooks, commands), which are plugins'. | yes |
| `package.runtime-type` | `requires.runtime` isn't a string. | yes |
| `package.runtime-unserved` | `requires.runtime` names a major version of `runtime` the reader doesn't serve. | yes |
| `package.spade-newer` | `requires.spade` is newer than the runtime. | no |
| `package.uses` | `uses` isn't a list of module names. | yes |
| `package.module` | `uses` names a module the runtime lacks. | yes |
| `package.triggers` | `triggers` isn't a list of at most 40. | yes |
| `package.trigger` | A trigger's fields aren't what its kind takes: places, a routine's name and instruction, a schedule the runtime reads, an event it names. | no |
| `package.routines` | More than 32 routines, or two routines of one name. | no |
| `package.price` | Any price but free. | yes |
| `package.field` | A field of the manifest isn't its shape, or is past its bound. | no |
<!-- spec:end rules -->

## Conformance

<!-- spec:begin cases -->
From [`conformance/package/manifests.json`](conformance/package/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/base-manifest` | the base manifest | accept |
| `package/spec-of-this-version` | the spec version it was written for | accept |
| `package/spec-of-a-later-minor-version` | a later minor version of the spec, which a reader of its major reads | accept |
| `package/spec-of-another-major-version` | another major version of the spec | refuse by `package.spec` |
| `package/spec-as-a-number` | the spec version as a number | refuse by `package.spec` |
| `package/schema-address` | the address of the format's JSON Schema, for editors | accept |
| `package/runtime-as-a-number` | runtime as a number | refuse by `package.runtime-type` |
| `package/runtime-this-build-doesnt-serve` | a runtime this build doesn't serve | refuse by `package.runtime-unserved` |
| `package/publisher-in-the-file` | a publisher in the file | refuse by `package.identity` |
| `package/price` | a price | refuse by `package.price` |
| `package/server` | a server | refuse by `package.execution` |
| `package/module-this-build-doesnt-have` | a module this build doesn't have | refuse by `package.module` |
| `package/triggers-as-an-object` | triggers as an object | refuse by `package.triggers` |
| `package/uses-as-a-word` | uses as a word | refuse by `package.uses` |
<!-- spec:end cases -->

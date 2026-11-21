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
| `checks` | What a result is held to before it counts as done: `schema` rules on contract outputs and cards, `criterion` lines on the goal (below). |
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
| `code` | The tools of the package's own WebAssembly components (ADR 0203), one per tool a component gives, named `code_<component>_<tool>`. Each runs in the bot's sandbox with no authority of its own: what it reaches through `spade:package/http` and `spade:package/tools` Spade does after the gate, the ceiling first. A component the person turned off gives no tools. |
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

A schedule, event or webhook trigger MAY say `"verify": true`: each of its runs opens a goal
from the trigger's instruction with the package's `criterion` checks as its criteria, and a
runtime MUST NOT count the run done until that goal's check of done says so. On any other
trigger, or with a value other than `true` or `false`, the manifest is refused.

## Checks

`checks` lists what a result is held to before it counts as done. A check is on one or more
places: `contract:<name>` (one of the package's contracts: its output, before the caller gets
it), `card:<id>` (one of the package's cards: its data, before it is shown) or `goal` (the
goal, when the bot says it is done).

| `kind`      | What it holds                                                                 | On                  |
| ----------- | ----------------------------------------------------------------------------- | ------------------- |
| `schema`    | `rule`: a rule in the subset below, which the result MUST hold                 | contracts and cards |
| `criterion` | `text`: one line, added to the goal's criteria and judged by the check of done | the goal only       |
| `code`      | `code`: a component's `check` export; refused until a runtime runs package code | contracts and cards |

A runtime MUST NOT pass a result whose check fails: the result goes back to the bot with the
reasons, at most twice, and then the call fails, the card isn't shown, or the goal reads not yet.
Checks only add conditions; they never mark done what the runtime's own check refused. A rule is
the contract subset's keywords plus `pattern`, with `type` and every bound optional, since it
narrows a value the contract's or card's own schema already bounds. A keyword of one kind of
value refuses the rule when another kind's keyword or another `type` is beside it. A `pattern`
matches anywhere in the text unless anchored, in the part of regular expressions both Rust's
`regex` and JavaScript's `RegExp` (with the `u` and `s` flags) read the same way: literals,
`.`, `^`, `$`, `|`, groups, `*`, `+`, `?`, counts and classes with ranges. A backslash escapes
only punctuation; `\d`, `\w`, `\s`, `\b`, `(?…)`, a `[` inside a class, `&&`, `--` and `~~` in a
class, an empty class and an unescaped `]` or `}` outside a class are refused.

<!-- spec:begin checks -->
A check has `name`, `on`, `kind`, `rule`, `text`, `code`.

| What | Bound |
| --- | --- |
| checks in a package | at most 32 |
| a check's `name` | 1 to 40 lower-case letters, digits and dashes, each once |
| a check's `on` | 1 to 8 places |
| `criterion` checks | at most 8, each `text` at most 500 characters |
| a rule's `pattern` | 1 to 200 characters, counts at most 1,000 |

A rule's keywords, by the kind of value they narrow (every rule also takes `type`, `description`, `title`):

| Kind | Keywords |
| --- | --- |
| `object` | `properties`, `required` |
| `string` | `minLength`, `maxLength`, `enum`, `pattern` |
| `number, integer` | `minimum`, `maximum` |
| `array` | `items`, `minItems`, `maxItems` |
<!-- spec:end checks -->

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
| `checks.list` | `checks` isn't a list of at most 32. | yes |
| `checks.field` | A check isn't an object, or holds a field checks don't have. | no |
| `checks.name` | A check's name isn't 1 to 40 lower-case letters, digits and dashes. | no |
| `checks.name-unique` | Two checks have one name. | no |
| `checks.on` | A check's `on` isn't 1 to 8 places, each once: one of the package's contracts (`contract:<name>`), one of its cards (`card:<id>`) or `goal`. | no |
| `checks.kind` | A check's kind isn't `schema`, `code` or `criterion`. | no |
| `checks.code-later` | A `code` check, which the runtime doesn't run yet. | no |
| `checks.schema-place` | A `schema` check is on the goal, or has no `rule`. | no |
| `checks.criterion` | A `criterion` check is on anything but the goal, or doesn't say in 1 to 500 characters what must hold. | no |
| `checks.criteria` | More than 8 `criterion` checks. | no |
| `check-rule.size` | A check's rule is longer than 16 KiB. | no |
| `check-rule.object` | A check's rule isn't a JSON object. | no |
| `check-rule.keyword` | A check's rule uses a keyword outside the rule subset. | no |
| `check-rule.mixed` | A check's rule mixes keywords of different kinds of value. | no |
| `check-rule.type` | A check's rule names a `type` that isn't one, or one its keywords don't narrow. | no |
| `check-rule.text` | A check's rule's `description` or `title` isn't text of at most 500 characters. | no |
| `check-rule.depth` | A check's rule nests more than 6 levels. | no |
| `check-rule.fields` | A check's rule names more than 64 fields, or a field name that isn't 1 to 64 letters, digits and `_`. | no |
| `check-rule.required` | A check's rule's `required` isn't a list of field names. | no |
| `check-rule.enum` | A check's rule's enum isn't 1 to 64 words of at most 200 characters. | no |
| `check-rule.bound` | A check's rule's bound isn't a number in its range, or a lower bound is past its upper one. | no |
| `check-rule.pattern` | A check's rule's `pattern` is outside the part of regular expressions both readers read alike, or longer than 200 characters. | no |
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

<!-- spec:begin check-cases -->
From [`conformance/package/checks.json`](conformance/package/checks.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/checks-schema-and-criterion` | a schema check on a contract and a card, and a criterion on the goal | accept |
| `package/checks-not-a-list` | checks that aren't a list | refuse by `checks.list` |
| `package/checks-name-twice` | two checks with one name | refuse by `checks.name-unique` |
| `package/checks-bad-name` | a check named with capitals | refuse by `checks.name` |
| `package/checks-unknown-contract` | a check on a contract the package doesn't publish | refuse by `checks.on` |
| `package/checks-unknown-card` | a check on a card the package doesn't ship | refuse by `checks.on` |
| `package/checks-no-places` | a check on nothing | refuse by `checks.on` |
| `package/checks-unknown-place` | a check on a place that isn't a contract, card or goal | refuse by `checks.on` |
| `package/checks-schema-on-goal` | a schema check on the goal | refuse by `checks.schema-place` |
| `package/checks-criterion-on-contract` | a criterion check on a contract | refuse by `checks.criterion` |
| `package/checks-criterion-without-text` | a criterion check that says nothing | refuse by `checks.criterion` |
| `package/checks-code` | a code check, which this build can't run | refuse by `checks.code-later` |
| `package/checks-unknown-kind` | a check of a kind that doesn't exist | refuse by `checks.kind` |
| `package/checks-unknown-field` | a check with a field checks don't have | refuse by `checks.field` |
| `package/checks-schema-without-rule` | a schema check with no rule | refuse by `checks.schema-place` |
| `package/checks-rule-outside-subset` | a rule with a keyword outside the subset | refuse by `check-rule.keyword` |
| `package/checks-too-many-criteria` | nine criterion checks | refuse by `checks.criteria` |
| `package/triggers-verify` | a schedule trigger that verifies each run | accept |
| `package/triggers-verify-not-a-flag` | verify that isn't true or false | refuse by `package.trigger` |
| `package/triggers-verify-on-message` | verify on a message trigger | refuse by `package.trigger` |
<!-- spec:end check-cases -->

<!-- spec:begin rule-cases -->
From [`conformance/package/check-rules.json`](conformance/package/check-rules.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/rule-required-link-over-https` | a link that must be there and start with https:// | accept |
| `package/rule-narrowed-numbers-and-lists` | numbers and lists narrowed further | accept |
| `package/rule-words-and-lengths` | words from a list, and lengths | accept |
| `package/rule-classes-groups-and-counts` | a pattern with classes, groups, alternation and counts | accept |
| `package/rule-refuses-unknown-keyword` | a keyword outside the subset | refuse by `check-rule.keyword` |
| `package/rule-refuses-ref` | a reference to another schema | refuse by `check-rule.keyword` |
| `package/rule-refuses-mixed-keywords` | keywords of two types in one rule | refuse by `check-rule.mixed` |
| `package/rule-refuses-keyword-of-another-type` | a keyword its type doesn't take | refuse by `check-rule.type` |
| `package/rule-refuses-shorthand-class` | a shorthand class like \d | refuse by `check-rule.pattern` |
| `package/rule-refuses-lookaround` | a look-ahead group | refuse by `check-rule.pattern` |
| `package/rule-refuses-nested-class` | a [ inside a class | refuse by `check-rule.pattern` |
| `package/rule-refuses-class-set-operation` | && inside a class | refuse by `check-rule.pattern` |
| `package/rule-refuses-double-dash-in-class` | -- inside a class | refuse by `check-rule.pattern` |
| `package/rule-refuses-empty-class` | an empty class | refuse by `check-rule.pattern` |
| `package/rule-refuses-lone-bracket` | an unescaped ] outside a class | refuse by `check-rule.pattern` |
| `package/rule-refuses-lone-brace` | a { that isn't a count | refuse by `check-rule.pattern` |
| `package/rule-refuses-big-count` | a count over 1,000 | refuse by `check-rule.pattern` |
| `package/rule-refuses-unclosed-class` | a class never closed | refuse by `check-rule.pattern` |
| `package/rule-refuses-long-pattern` | a pattern over 200 characters | refuse by `check-rule.pattern` |
| `package/rule-refuses-deep-rule` | a rule seven levels deep | refuse by `check-rule.depth` |
| `package/rule-refuses-required-not-names` | required that isn't a list of names | refuse by `check-rule.required` |
<!-- spec:end rule-cases -->

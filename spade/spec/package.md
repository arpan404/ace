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
| `format` | MUST be `"spade-bot"`. |
| `version` | The format's number, `3`. A string is refused: a package's own version is the signed version manifest's. |
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

## Conformance

<!-- spec:begin cases -->
From [`conformance/package/manifests.json`](conformance/package/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/base-manifest` | the base manifest | accept |
| `package/runtime-as-a-number` | runtime as a number | refuse: a problem says “requires.runtime is a string” |
| `package/runtime-this-build-doesnt-serve` | a runtime this build doesn't serve | refuse: a problem says “Needs a newer Spade” |
| `package/publisher-in-the-file` | a publisher in the file | refuse: a problem says “signed manifest” |
| `package/price` | a price | refuse: a problem says “Paid” |
| `package/server` | a server | refuse: a problem says “plugin” |
| `package/module-this-build-doesnt-have` | a module this build doesn't have | refuse: a problem says “telepathy” |
| `package/triggers-as-an-object` | triggers as an object | refuse: a problem says “triggers is a list” |
| `package/uses-as-a-word` | uses as a word | refuse: a problem says “uses lists runtime modules” |
<!-- spec:end cases -->

<!-- spec:begin check-cases -->
From [`conformance/package/checks.json`](conformance/package/checks.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/checks-schema-and-criterion` | a schema check on a contract and a card, and a criterion on the goal | accept |
| `package/checks-not-a-list` | checks that aren't a list | refuse: a problem says “checks is a list of at most 32” |
| `package/checks-name-twice` | two checks with one name | refuse: a problem says “each check has a name of its own” |
| `package/checks-bad-name` | a check named with capitals | refuse: a problem says “name is a short name” |
| `package/checks-unknown-contract` | a check on a contract the package doesn't publish | refuse: a problem says “isn't one of the package's contracts” |
| `package/checks-unknown-card` | a check on a card the package doesn't ship | refuse: a problem says “isn't one of the package's cards” |
| `package/checks-no-places` | a check on nothing | refuse: a problem says “on names 1 to 8 places” |
| `package/checks-unknown-place` | a check on a place that isn't a contract, card or goal | refuse: a problem says “is contract:<name>, card:<id> or goal” |
| `package/checks-schema-on-goal` | a schema check on the goal | refuse: a problem says “a schema check is on contracts and cards” |
| `package/checks-criterion-on-contract` | a criterion check on a contract | refuse: a problem says “a criterion check is on the goal only” |
| `package/checks-criterion-without-text` | a criterion check that says nothing | refuse: a problem says “text says in 1 to 500 characters” |
| `package/checks-code` | a code check, which this build can't run | refuse: a problem says “Needs a newer Spade: code checks” |
| `package/checks-unknown-kind` | a check of a kind that doesn't exist | refuse: a problem says “kind is schema, code or criterion” |
| `package/checks-unknown-field` | a check with a field checks don't have | refuse: a problem says “isn't a field of a check” |
| `package/checks-schema-without-rule` | a schema check with no rule | refuse: a problem says “rule is the rule the result must hold” |
| `package/checks-rule-outside-subset` | a rule with a keyword outside the subset | refuse: a problem says “isn't in the rule subset checks use” |
| `package/checks-too-many-criteria` | nine criterion checks | refuse: a problem says “at most 8 criterion checks” |
| `package/triggers-verify` | a schedule trigger that verifies each run | accept |
| `package/triggers-verify-not-a-flag` | verify that isn't true or false | refuse: a problem says “verify is true or false” |
| `package/triggers-verify-on-message` | verify on a message trigger | refuse: a problem says “verify is for a schedule, event or webhook trigger” |
<!-- spec:end check-cases -->

<!-- spec:begin rule-cases -->
From [`conformance/package/check-rules.json`](conformance/package/check-rules.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `package/rule-required-link-over-https` | a link that must be there and start with https:// | accept |
| `package/rule-narrowed-numbers-and-lists` | numbers and lists narrowed further | accept |
| `package/rule-words-and-lengths` | words from a list, and lengths | accept |
| `package/rule-classes-groups-and-counts` | a pattern with classes, groups, alternation and counts | accept |
| `package/rule-refuses-unknown-keyword` | a keyword outside the subset | refuse: a problem says “isn't in the rule subset checks use” |
| `package/rule-refuses-ref` | a reference to another schema | refuse: a problem says “isn't in the rule subset checks use” |
| `package/rule-refuses-mixed-keywords` | keywords of two types in one rule | refuse: a problem says “mixes keywords of different types” |
| `package/rule-refuses-keyword-of-another-type` | a keyword its type doesn't take | refuse: a problem says “takes none of the number keywords” |
| `package/rule-refuses-shorthand-class` | a shorthand class like \d | refuse: a problem says “write \d another way” |
| `package/rule-refuses-lookaround` | a look-ahead group | refuse: a problem says “has no (?…) groups” |
| `package/rule-refuses-nested-class` | a [ inside a class | refuse: a problem says “escapes a [ inside a class” |
| `package/rule-refuses-class-set-operation` | && inside a class | refuse: a problem says “doesn't use && inside a class” |
| `package/rule-refuses-double-dash-in-class` | -- inside a class | refuse: a problem says “doesn't use -- inside a class” |
| `package/rule-refuses-empty-class` | an empty class | refuse: a problem says “has no empty class” |
| `package/rule-refuses-lone-bracket` | an unescaped ] outside a class | refuse: a problem says “escapes a ] outside a class” |
| `package/rule-refuses-lone-brace` | a { that isn't a count | refuse: a problem says “repeats with {n}” |
| `package/rule-refuses-big-count` | a count over 1,000 | refuse: a problem says “repeats with {n}” |
| `package/rule-refuses-unclosed-class` | a class never closed | refuse: a problem says “closes every class it opens” |
| `package/rule-refuses-long-pattern` | a pattern over 200 characters | refuse: a problem says “is 1 to 200 characters” |
| `package/rule-refuses-deep-rule` | a rule seven levels deep | refuse: a problem says “a rule nests at most 6 levels” |
| `package/rule-refuses-required-not-names` | required that isn't a list of names | refuse: a problem says “required is a list of field names” |
<!-- spec:end rule-cases -->

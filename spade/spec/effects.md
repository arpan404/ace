<!-- spec:begin header -->
# Spade Agent Format 1.0: Effects

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `effects`, version 1.0, of the [Spade Agent Format](README.md) 1.0. The effect words and their order, the ceiling rule, install switches, the person-only effects, workers inheriting the ceiling.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

## The words

Every call a bot makes has an effect: one of these words, from least to most serious. A runtime
reads a call's effect itself, from what the call is and does; a package's words about a call
MUST NOT change the effect it is read as.

<!-- spec:begin words -->
| Order | Word | What a call with it does |
| --- | --- | --- |
| 1 | `read` | Only reads. |
| 2 | `write_local` | Changes only the bot's own things: its folder, notes, plan, routines and workers. |
| 3 | `network` | Changes or reaches something outside the bot: a server, an app's data, another bot. |
| 4 | `publish` | Publishes: a release, a package, a deploy, a merge. |
| 5 | `send_as_person` | Sends something in the person's name: a message, a mail, a comment, a push. |
| 6 | `pay` | Spends money. |
| 7 | `drive` | Acts in a page or an app the way the person would: a click, typing, a key. |
| 8 | `change_access` | Changes sign-ins, keys or who has access. |
| 9 | `unknown` | A word the runtime doesn't know. It is read as the person's to decide, never as nothing. |
| 10 | `credential` | Hands back a secret. A runtime never gives one to a bot. |
<!-- spec:end words -->

## The ceiling

A package's `effects` list is a ceiling: what its bot may do beyond `read` and `write_local`,
which every bot has inside its own things. Each entry is `{effect, why, hosts?, grant?}`:

- `effect`: a word a package may declare (below).
- `why`: one sentence the person reads before they decide.
- `hosts`: for `network` only, the hosts the bot may reach (`api.example.com`, `*.example.com`).
- `grant`: for `network` or `publish`, one grant the person's switch makes: `drive_site {host}`
  or `drive_app {app}` (acting in one site or app as the person) or `tool {tool, arguments?}`
  (one tool, never one that sends, pays or changes access). Never both `hosts` and `grant`.

<!-- spec:begin declared -->
| Word | A package may declare it | A call with it needs declared | Goes to the person | A tool with it may be granted |
| --- | --- | --- | --- | --- |
| `read` | no | nothing | no | yes |
| `write_local` | no | nothing | no | yes |
| `network` | yes | `network` | no | yes |
| `publish` | yes | `publish` | no | yes |
| `send_as_person` | yes | `send_as_person` | every call | never |
| `pay` | yes | `pay` | every call | never |
| `drive` | no | `network` | no | never |
| `change_access` | yes | `change_access` | every call | never |
| `unknown` | no | nothing | every call | never |
| `credential` | no | nothing | no | never |
<!-- spec:end declared -->

A runtime MUST refuse any call whose effect, as the runtime reads it, needs a word the package
didn't declare or the person turned off. The refusal comes before anything else the runtime
decides, in every mode, including one where the person allows everything. A call whose effect
the runtime can't resolve MUST be refused unless the runtime holds it where nothing it does
reaches a server.

Declaring an effect grants nothing. An effect marked as going to the person goes to the person
on every call, whatever they answered before: no standing answer, typed grant or kept approval
carries to it.

## Switches

Each declared effect is a switch the person turns on or off at install, and after. Only what
the person leaves on is granted, and turning a switch off takes back exactly what it made. A
switch is known by a stable key, the same in every reader:

<!-- spec:begin keys -->
| Declared (`why` aside) | Its switch's key |
| --- | --- |
| `{"effect": "publish"}` | `publish` |
| `{"effect": "network", "hosts": ["b.example.com", "a.example.com"]}` | `network:hosts:a.example.com,b.example.com` |
| `{"effect": "network", "grant": {"kind": "drive_site", "host": "example.com"}}` | `network:drive_site:example.com` |
| `{"effect": "network", "grant": {"kind": "drive_app", "app": "org.example.notes"}}` | `network:drive_app:org.example.notes` |
| `{"effect": "network", "grant": {"kind": "tool", "tool": "web_fetch"}}` | `network:tool:web_fetch` |
<!-- spec:end keys -->

A runtime MUST read the switches again right before a call starts, so a call decided while a
switch was on never runs after the person turned it off.

## Workers and bots it makes

A worker or helper under a packaged bot is held to the ceiling of every packaged bot above it.
A bot a packaged bot makes for the person is held to its maker's ceiling, as it was when it was
made and narrowed by the maker's as it is now; it never widens again.

## Rules

Every refusal names its rule; a conformance case matches it by id, never by words.

<!-- spec:begin rules -->
From [`conformance/rules.json`](conformance/rules.json).

| Rule | A reader MUST refuse | The JSON Schema decides it |
| --- | --- | --- |
| `effects.list` | `effects` isn't a list of at most 32. | yes |
| `effects.credential` | The `credential` effect is declared. | yes |
| `effects.drive` | `drive` is declared as an effect of its own, not as a `network` grant. | yes |
| `effects.word` | An effect's word isn't an effect. | yes |
| `effects.why` | An effect doesn't say why, in 1 to 500 characters. | yes |
| `effects.hosts-only-network` | An effect other than `network` names hosts. | yes |
| `effects.hosts` | `hosts` isn't 1 to 32 host names. | no |
| `effects.hosts-and-grant` | An effect asks for hosts and a grant both. | yes |
| `effects.never-granted` | A grant under an effect other than `network` or `publish`, which go to the person. | yes |
| `effects.grant` | A grant isn't a `drive_site`, `drive_app` or `tool` grant a package may ask for. | no |
| `effects.person-only` | A grant of what is the person's alone: a push, a comment, a folder, or a tool that sends in the person's name. | yes |
| `effects.twice` | An effect is declared twice. | no |
<!-- spec:end rules -->

## Conformance

<!-- spec:begin cases -->
From [`conformance/effects/manifests.json`](conformance/effects/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `effects/read-and-write-local-declared-which-every-bot-has` | read and write_local declared, which every bot has | accept |
| `effects/driving-one-site-under-network` | driving one site under network | accept |
| `effects/declared-send-which-goes-to-the-person-each-time` | a declared send, which goes to the person each time | accept |
| `effects/network-grant-of-git-push` | a network grant of git_push | refuse by `effects.person-only` |
| `effects/network-grant-of-send-message` | a network grant of send_message | refuse by `effects.person-only` |
| `effects/network-grant-of-issue-comment` | a network grant of issue_comment | refuse by `effects.person-only` |
| `effects/network-grant-of-pr-comment` | a network grant of pr_comment | refuse by `effects.person-only` |
| `effects/push-grant` | a push grant | refuse by `effects.person-only` |
| `effects/grant-under-a-send` | a grant under a send | refuse by `effects.never-granted` |
| `effects/hosts-under-publish` | hosts under publish | refuse by `effects.hosts-only-network` |
| `effects/credential` | credential | refuse by `effects.credential` |
| `effects/drive` | drive | refuse by `effects.drive` |
| `effects/word-that-isnt-an-effect` | a word that isn't an effect | refuse by `effects.word` |
| `effects/effects-as-an-object` | effects as an object | refuse by `effects.list` |
| `effects/effects-as-a-word` | effects as a word | refuse by `effects.list` |
<!-- spec:end cases -->

<!-- spec:begin header -->
# Spade Agent Format 1.0: Surfaces

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `surfaces`, version 1.0, of the [Spade Agent Format](README.md) 1.0. Card layout parts and actions, panels, their state and actions, the panel message protocol and `confirm` actions.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

What a bot shows besides its reply: cards, which are data the runtime draws with its own parts,
and panels, which are pages a package ships, isolated from everything else.

## Declaring them

`surfaces` in the manifest is a list. Each entry has an `id` of lower-case letters, digits and
dashes, its own in the package, and a `kind`:

- `card`: `file` is `cards/<name>.json`, a card the bot may show by id.
- `panel`: `file` is exactly `panels/<id>/index.html`, one self-contained page: its scripts and
  styles inline, its images `data:` addresses. It has a `title`, an optional `state` schema (what
  the bot may set) and `actions`, each `{name, label, value?, confirm?}`: `name` in lower-case
  letters, digits and underscores, `value` the schema of what it carries, and `confirm: true`
  when only the person may send it.

`state` and each `value` are schemas in the bounded subset of the [contracts](contracts.md)
part. A kind the reader doesn't know MUST be refused, saying the package needs a newer runtime.

<!-- spec:begin bounds -->
| What | Bound |
| --- | --- |
| `surfaces` | at most 16 |
| panels among them | at most 8 |
| a panel's `title` | at most 60 characters |
| a panel's `actions` | at most 16 |
| an action's `label` | at most 40 characters |
| a panel's state, as JSON | 64 KiB |
| an action's value, as JSON | 8 KiB |
| a panel's page | 1 MiB |
<!-- spec:end bounds -->

## Cards

A card is a title and blocks, checked against each block kind's rules before it is shown; a
card that doesn't fit MUST be refused with every problem, never shown half drawn. A client that
meets a block kind it doesn't know leaves that block out and draws the rest.

<!-- spec:begin blocks -->
A card's blocks are of these kinds: `fields`, `metric`, `progress`, `table`, `list`, `image`, `link`, `actions`.
<!-- spec:end blocks -->

An `actions` block holds at most a few actions, each of a fixed kind: `choose {id, label}`
sends its label back to the bot once, as the person's choice; `open {label, url}` opens an
`https` address, its host shown first; `open {label, panel}` opens one of the bot's own panels.
No action runs anything on its own.

<!-- spec:begin card-bounds -->
| What | Bound |
| --- | --- |
| blocks under the title | at most 12 |
| the title | at most 120 characters |
| a label | at most 60 characters |
| an action's label | at most 40 characters |
| a value or a list item | at most 200 characters |
| a table cell | at most 120 characters |
| `fields` rows | at most 12 |
| `list` items | at most 20 |
| `table` columns | at most 6 |
| `table` rows | at most 50 |
| actions on a card | at most 4 |
| the whole card, as JSON | 16 KiB |
<!-- spec:end card-bounds -->

## Panels

The bot sets a panel's whole state with `panel_update {surface, data}`, checked against the
panel's `state` schema and refused with every problem at its place.

A runtime MUST run a panel's page isolated: an opaque origin, scripts and styles from the page
only, no network, no storage, no access to the conversation, the runtime or the rest of the
client. It gives the page its theme and the latest state, and takes from it only actions.

- **An action from the page is the page's, never the person's.** The bot reads it as untrusted
  input from its package, it taints the bot's turn as another bot's message does, and it never
  answers a question or an approval. A client sends one only while the person is pressing or
  typing in the page, only for an action the panel declares, and at most a few in a short time;
  the runtime checks its value against the action's schema.
- **A `confirm` action is the person's.** The client draws its own line outside the page,
  naming the panel, the action's label and its value in words, with Cancel and Confirm. It
  sends the action only on a press of Confirm the browser made from real input, after a short
  delay, and never on a script's click. Only then does the bot read it as the person's.
- **Every message out of the page** is JSON text of at most 16 KiB of UTF-8. Anything else is
  dropped unread.

A page that throws, or stops answering the client's pings, is stopped and offered again.

## Rules

Every refusal names its rule; a conformance case matches it by id, never by words.

<!-- spec:begin rules -->
From [`conformance/rules.json`](conformance/rules.json).

| Rule | A reader MUST refuse | The JSON Schema decides it |
| --- | --- | --- |
| `surfaces.list` | `surfaces` isn't a list of at most 16. | yes |
| `surfaces.field` | A surface isn't an object. | yes |
| `surfaces.id` | A surface's id isn't lower-case letters, digits and dashes. | yes |
| `surfaces.id-unique` | Two surfaces have one id. | no |
| `surfaces.kind` | A surface's kind isn't `card` or `panel`. | yes |
| `surfaces.card-file` | A card's file isn't `cards/<name>.json`. | yes |
| `surfaces.panel-file` | A panel's page isn't `panels/<id>/index.html`, in its own folder. | no |
| `surfaces.title` | A panel isn't named in a few words (`title`, at most 60 characters). | yes |
| `surfaces.panels` | More than 8 panels. | no |
| `surfaces.actions` | A panel's `actions` isn't a list of at most 16. | yes |
| `surfaces.action-name` | An action's name isn't lower-case letters, digits and underscores. | yes |
| `surfaces.action-name-unique` | Two actions of one panel have one name. | no |
| `surfaces.action-label` | An action's label isn't a few words (at most 40 characters). | yes |
| `surfaces.confirm` | An action's `confirm` isn't true or false. | yes |
<!-- spec:end rules -->

## Conformance

<!-- spec:begin cases -->
From [`conformance/surfaces/manifests.json`](conformance/surfaces/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `surfaces/panel-with-its-state-and-actions` | a panel with its state and actions | accept |
| `surfaces/card-and-a-panel-with-no-state-as-the-adrs-example-has-them` | a card and a panel with no state, as the ADR's example has them | accept |
| `surfaces/surfaces-as-an-object` | surfaces as an object | refuse by `surfaces.list` |
| `surfaces/panels-page-outside-its-folder` | a panel's page outside its folder | refuse by `surfaces.panel-file` |
| `surfaces/panel-with-no-title` | a panel with no title | refuse by `surfaces.title` |
| `surfaces/surface-id-in-capitals` | a surface id in capitals | refuse by `surfaces.id` |
| `surfaces/two-surfaces-with-one-id` | two surfaces with one id | refuse by `surfaces.id-unique` |
| `surfaces/surface-kind-this-build-doesnt-have` | a surface kind this build doesn't have | refuse by `surfaces.kind` |
| `surfaces/cards-file-outside-cards` | a card's file outside cards/ | refuse by `surfaces.card-file` |
| `surfaces/state-with-a-keyword-this-build-doesnt-enforce` | state with a keyword this build doesn't enforce | refuse by `schema.keyword` |
| `surfaces/state-requiring-a-field-it-doesnt-have` | state requiring a field it doesn't have | refuse by `schema.required` |
| `surfaces/state-nested-more-than-six-levels` | state nested more than six levels | refuse by `schema.depth` |
| `surfaces/enum-of-no-words` | an enum of no words | refuse by `schema.enum` |
| `surfaces/two-actions-with-one-name` | two actions with one name | refuse by `surfaces.action-name-unique` |
| `surfaces/action-named-with-a-dash` | an action named with a dash | refuse by `surfaces.action-name` |
| `surfaces/confirm-that-is-not-true-or-false` | a confirm that is not true or false | refuse by `surfaces.confirm` |
<!-- spec:end cases -->

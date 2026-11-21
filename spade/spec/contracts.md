<!-- spec:begin header -->
# Spade Agent Format 1.0: Contracts

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `contracts`, version 1.0, of the [Spade Agent Format](README.md) 1.0. Contract declaration, call and return, the bounded schema subset, input and output bounds, held effects, taint at entry, exactly-once keys, compatible changes.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

A contract is a typed call the person's other bots may make to a packaged bot: input of a shape
the caller writes, output of a shape the caller can rely on.

## Declaring one

`contracts` in the manifest is a list. Each contract holds:

<!-- spec:begin fields -->
`name`, `summary`, `input`, `output`, `effects`, `examples`.
<!-- spec:end fields -->

- `name`: lower-case words joined by `_`, its own in the package; what callers name.
- `summary`: one line on what it answers.
- `input`, `output`: schemas in the subset below.
- `effects`: what the callee may use while it answers, beyond reading and its own things. Each
  MUST be one the package declares; `read` and `write_local` are implied.
- `examples`: inputs and their outputs, each of which MUST fit the schemas.

A contract MAY keep its schemas in a file of the package instead: `"file":
"contracts/<name>.json"` in place of `input` and `output`, the file holding exactly those two.
A reader MUST write the file into the contract before it reads the manifest, so every reader
sees one form, and MUST refuse a contract that names its schemas in both places, a file that
isn't in the package, isn't a JSON object, or holds any other field. A field a contract doesn't
have refuses it.

<!-- spec:begin bounds -->
| What | Bound |
| --- | --- |
| contracts in a package | at most 16 |
| `summary` | at most 200 characters |
| `examples` | at most 8 |
| a call's input, as JSON | 64 KiB |
| a call's output, as JSON | 256 KiB |
| a contract's schema file | 40 KiB |
<!-- spec:end bounds -->

## The schema subset

Contract input and output, a panel's state and an action's value are written in a bounded
subset of JSON Schema. A keyword outside it MUST refuse the schema, so a schema never promises a
check a reader doesn't make.

<!-- spec:begin subset -->
| `type` | Keywords |
| --- | --- |
| `object` | `properties`, `required`, `additionalProperties` |
| `string` | `maxLength`, `minLength`, `enum` |
| `number`, `integer` | `minimum`, `maximum` |
| `boolean` | none |
| `array` | `items`, `maxItems`, `minItems` |

Every kind also takes `type`, `description`, `title`.
<!-- spec:end subset -->

An `enum` alone is a string enum. Where a value is written (a call's input, the callee's
output), an object takes no field it doesn't name. A caller reading an output MUST pass fields
its schema doesn't name, since the callee may run a newer version that added them, and check
every field it names.

<!-- spec:begin subset-bounds -->
| What | Bound |
| --- | --- |
| levels deep, the top value being one | 6 |
| an object's `properties` | at most 64 |
| an `enum`'s words | 1 to 64 |
| an `enum` word | at most 200 characters |
| a string's `maxLength`, which it MUST have | 1 to 65,536 |
| a list's `maxItems`, which it MUST have | 1 to 1,000 |
| `description` and `title` | at most 500 characters |
| the whole schema, as JSON | 16 KiB |
<!-- spec:end subset-bounds -->

## Calling

<!-- spec:begin tools -->
| Tool | Module | Effect | Since |
| --- | --- | --- | --- |
| `contracts_find` | `agents` | `read` | 0.0.25 |
| `contract_call` | `agents` | `write_local` | 0.0.25 |
| `contract_return` | `agents` | `write_local` | 0.0.25 |
<!-- spec:end tools -->

- **Exactly once.** Each call has an idempotency key from the caller's side. A runtime MUST
  deliver a call to its callee at most once under that key, and after a restart carry on from
  what it stored: the callee it pinned, its delivery and its outcome. A rename never redirects a
  stored call.
- **The callee's own gate.** The callee reads the call as another bot's input, never as the
  person's words, and it taints the callee's turn. From delivery until the reply that serves it
  ends, the callee is held to the contract's `effects` inside its package's ceiling; workers and
  helpers it starts for the call stay held. The caller's grants never pass to the callee.
- **Checked output.** The callee's answer MUST fit the output schema; a misfit goes back to the
  callee with its problems, and a few misfits fail the call. The caller checks the output again,
  as a reader.
- **Taint.** An output from a callee that had anything untrusted in view, or read any during
  the call, is marked untrusted, and so is the caller's result.
- **Who may call.** Only the person's own bots. The person MAY turn calls to a bot off.

## Compatible changes

A new version of a package MUST NOT break its contracts' callers. Breaking is: a contract gone;
an input field gone, newly required, taking less text, fewer items or a narrower range; an output
field gone or no longer always there, or an output that may now be longer, wider, or a word
callers never saw. A new optional output field is compatible. A breaking change takes a new
contract name.

## Rules

Every refusal names its rule; a conformance case matches it by id, never by words. The
`schema.*` rules are the bounded schema subset's, and hold for a panel's state and an action's
value too.

<!-- spec:begin rules -->
From [`conformance/rules.json`](conformance/rules.json).

| Rule | A reader MUST refuse | The JSON Schema decides it |
| --- | --- | --- |
| `contracts.list` | `contracts` isn't a list of at most 16. | yes |
| `contracts.field` | A contract isn't an object, or holds a field contracts don't have. | yes |
| `contracts.name` | A contract's name isn't lower-case words joined by `_`. | yes |
| `contracts.name-unique` | Two contracts have one name. | no |
| `contracts.summary` | A contract doesn't say in one line of at most 200 characters what it answers. | yes |
| `contracts.effect` | A contract's effects name a word a call may not use. | yes |
| `contracts.effect-undeclared` | A contract's effect isn't among the package's effects. | no |
| `contracts.example` | A contract's example isn't an input and output that fit its schemas. | no |
| `contracts.file` | A contract's schema file isn't `contracts/<name>.json`. | yes |
| `contracts.file-missing` | A contract's schema file isn't in the package. | no |
| `contracts.file-and-inline` | A contract writes its schemas both in bot.json and in a file. | yes |
| `contracts.file-content` | A contract's schema file isn't a JSON object of only `input` and `output`, of at most 40 KiB. | no |
| `schema.size` | A schema is longer than 16 KiB. | no |
| `schema.object` | A schema isn't a JSON object. | yes |
| `schema.keyword` | A schema uses a keyword outside the bounded subset. | yes |
| `schema.text` | A schema's `description` or `title` isn't text of at most 500 characters. | yes |
| `schema.type` | A schema's `type` isn't object, string, number, integer, boolean or array. | yes |
| `schema.depth` | A schema nests more than 6 levels. | no |
| `schema.closed` | An object's `additionalProperties` isn't false. | yes |
| `schema.fields` | An object names more than 64 fields, or a field name that isn't 1 to 64 letters, digits and `_`. | no |
| `schema.required` | `required` names a field the object doesn't have. | no |
| `schema.max-length` | A string doesn't say how long it may be (`maxLength`, 1 to 65,536). | yes |
| `schema.max-items` | A list doesn't say how long it may be (`maxItems`, 1 to 1,000), or what it holds. | yes |
| `schema.enum` | An enum isn't 1 to 64 words of at most 200 characters. | yes |
| `schema.bound` | A bound isn't a number, or a lower bound is past its upper one. | no |
<!-- spec:end rules -->

## Conformance

<!-- spec:begin cases -->
From [`conformance/contracts/manifests.json`](conformance/contracts/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `contracts/contract-with-an-example` | a contract with an example | accept |
| `contracts/contract-that-may-reach-the-hosts-the-package-declares` | a contract that may reach the hosts the package declares | accept |
| `contracts/contract-that-may-publish-which-the-package-doesnt-declare` | a contract that may publish, which the package doesn't declare | refuse by `contracts.effect-undeclared` |
| `contracts/contract-with-a-credential-effect` | a contract with a credential effect | refuse by `contracts.effect` |
| `contracts/two-contracts-of-one-name` | two contracts of one name | refuse by `contracts.name-unique` |
| `contracts/contract-named-in-capitals` | a contract named in capitals | refuse by `contracts.name` |
| `contracts/contract-with-no-summary` | a contract with no summary | refuse by `contracts.summary` |
| `contracts/contract-whose-string-has-no-length` | a contract whose string has no length | refuse by `schema.max-length` |
| `contracts/contract-whose-example-doesnt-fit-its-output` | a contract whose example doesn't fit its output | refuse by `contracts.example` |
| `contracts/contract-whose-schemas-live-in-its-file` | a contract whose schemas live in its file | accept |
| `contracts/contract-whose-schema-file-isnt-in-the-package` | a contract whose schema file isn't in the package | refuse by `contracts.file-missing` |
| `contracts/contract-schema-file-outside-contracts` | a contract schema file outside contracts/ | refuse by `contracts.file` |
| `contracts/contract-with-schemas-both-in-bot-json-and-in-a-file` | a contract with schemas both in bot.json and in a file | refuse by `contracts.file-and-inline` |
| `contracts/contract-schema-file-with-another-field` | a contract schema file with another field | refuse by `contracts.file-content` |
| `contracts/contract-schema-file-that-isnt-json` | a contract schema file that isn't JSON | refuse by `contracts.file-content` |
| `contracts/contract-schema-file-whose-schema-is-outside-the-subset` | a contract schema file whose schema is outside the subset | refuse by `schema.max-length` |
| `contracts/contracts-as-an-object` | contracts as an object | refuse by `contracts.list` |
| `contracts/contract-with-a-field-contracts-dont-have` | a contract with a field contracts don't have | refuse by `contracts.field` |
<!-- spec:end cases -->

### The schema subset

<!-- spec:begin schema-cases -->
From [`conformance/contracts/schemas.json`](conformance/contracts/schemas.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `contracts/schema-fare-question` | a fare question | accept |
| `contracts/schema-numbers-whole-numbers-enums-and-lists` | numbers, whole numbers, enums and lists | accept |
| `contracts/schema-six-levels-deep` | six levels deep | accept |
| `contracts/schema-seven-levels-deep` | seven levels deep | refuse by `schema.depth` |
| `contracts/schema-string-with-no-length` | a string with no length | refuse by `schema.max-length` |
| `contracts/schema-list-with-no-size` | a list with no size | refuse by `schema.max-items` |
| `contracts/schema-keyword-outside-the-subset` | a keyword outside the subset | refuse by `schema.keyword` |
| `contracts/schema-object-open-to-any-field` | an object open to any field | refuse by `schema.closed` |
| `contracts/schema-reference-to-another-schema` | a reference to another schema | refuse by `schema.keyword` |
| `contracts/schema-required-naming-a-field-it-doesnt-have` | required naming a field it doesn't have | refuse by `schema.required` |
| `contracts/schema-null-type` | a null type | refuse by `schema.type` |
<!-- spec:end schema-cases -->

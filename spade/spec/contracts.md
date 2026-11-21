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

## Conformance

<!-- spec:begin cases -->
From [`conformance/contracts/manifests.json`](conformance/contracts/manifests.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `contracts/contract-with-an-example` | a contract with an example | accept |
| `contracts/contract-that-may-reach-the-hosts-the-package-declares` | a contract that may reach the hosts the package declares | accept |
| `contracts/contract-that-may-publish-which-the-package-doesnt-declare` | a contract that may publish, which the package doesn't declare | refuse: a problem says “isn't among the package's effects” |
| `contracts/contract-with-a-credential-effect` | a contract with a credential effect | refuse: a problem says “isn't an effect a call may use” |
| `contracts/two-contracts-of-one-name` | two contracts of one name | refuse: a problem says “a name of its own” |
| `contracts/contract-named-in-capitals` | a contract named in capitals | refuse: a problem says “lower-case words” |
| `contracts/contract-with-no-summary` | a contract with no summary | refuse: a problem says “summary” |
| `contracts/contract-whose-string-has-no-length` | a contract whose string has no length | refuse: a problem says “maxLength” |
| `contracts/contract-whose-example-doesnt-fit-its-output` | a contract whose example doesn't fit its output | refuse: a problem says “examples[0].output.fare” |
| `contracts/contract-whose-schemas-live-in-its-file` | a contract whose schemas live in its file | accept |
| `contracts/contract-whose-schema-file-isnt-in-the-package` | a contract whose schema file isn't in the package | refuse: a problem says “contracts/cheapest-fare.json isn't in the package” |
| `contracts/contract-schema-file-outside-contracts` | a contract schema file outside contracts/ | refuse: a problem says “contracts[0].file is contracts/<name>.json” |
| `contracts/contract-with-schemas-both-in-bot-json-and-in-a-file` | a contract with schemas both in bot.json and in a file | refuse: a problem says “either in bot.json or in contracts/cheapest-fare.json” |
| `contracts/contract-schema-file-with-another-field` | a contract schema file with another field | refuse: a problem says “it holds only input and output” |
| `contracts/contract-schema-file-that-isnt-json` | a contract schema file that isn't JSON | refuse: a problem says “isn't a JSON object of input and output” |
| `contracts/contract-schema-file-whose-schema-is-outside-the-subset` | a contract schema file whose schema is outside the subset | refuse: a problem says “contracts[0].input” |
| `contracts/contracts-as-an-object` | contracts as an object | refuse: a problem says “contracts is a list” |
| `contracts/contract-with-a-field-contracts-dont-have` | a contract with a field contracts don't have | refuse: a problem says “isn't a field of a contract” |
<!-- spec:end cases -->

### The schema subset

<!-- spec:begin schema-cases -->
From [`conformance/contracts/schemas.json`](conformance/contracts/schemas.json).

| Case | What it is | A reader MUST |
| --- | --- | --- |
| `contracts/schema-fare-question` | a fare question | accept |
| `contracts/schema-numbers-whole-numbers-enums-and-lists` | numbers, whole numbers, enums and lists | accept |
| `contracts/schema-six-levels-deep` | six levels deep | accept |
| `contracts/schema-seven-levels-deep` | seven levels deep | refuse: a problem says “6 levels” |
| `contracts/schema-string-with-no-length` | a string with no length | refuse: a problem says “maxLength” |
| `contracts/schema-list-with-no-size` | a list with no size | refuse: a problem says “maxItems” |
| `contracts/schema-keyword-outside-the-subset` | a keyword outside the subset | refuse: a problem says “pattern” |
| `contracts/schema-object-open-to-any-field` | an object open to any field | refuse: a problem says “additionalProperties” |
| `contracts/schema-reference-to-another-schema` | a reference to another schema | refuse: a problem says “$ref” |
| `contracts/schema-required-naming-a-field-it-doesnt-have` | required naming a field it doesn't have | refuse: a problem says “required” |
| `contracts/schema-null-type` | a null type | refuse: a problem says “type” |
<!-- spec:end schema-cases -->

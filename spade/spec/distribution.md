<!-- spec:begin header -->
# Spade Agent Format 1.0: Distribution

<!-- SPDX-License-Identifier: CC-BY-4.0 -->
<!-- Text between spec:begin and spec:end marks is written from Spade's data (ADR 0201 §4). Don't edit it by hand: change the data and run `SPADE_WRITE_SPEC=1 cargo test -p spade-core spec_doc`. -->

Part `distribution`, version 1.0, of the [Spade Agent Format](README.md) 1.0. The content hash, the signed version manifest, withdrawal and scenario test files.

This text is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the schemas and the conformance suite under Apache-2.0 ([LICENSE.md](LICENSE.md)). The key words MUST, MUST NOT, SHOULD and MAY are to be read as RFC 2119 and RFC 8174 define them, when in capitals.
<!-- spec:end header -->

How a package travels from its publisher to a runtime with its identity intact.

## The content hash

A package's content hash is the sha256, in lower-case hex, of one line per file of the folder,
in path order: the JSON array `[path, bytes, executable, sha256]` (the path with `/` between
parts, the file's size in bytes, whether it is executable, and the sha256 of its bytes in hex),
each followed by a newline.

## The signed version manifest

A registry that lists a package signs one manifest per version: a body with the package's
`format`, `type`, `name`, `version`, content `hash`, every file with its size and sha256, and
the signing `key`'s id, and the signature over it.

<!-- spec:begin label -->
The signature is Ed25519 over the label `ace-market-manifest-v1`, a newline, and the body's canonical JSON (keys sorted at every depth, no spaces).
<!-- spec:end label -->

A reader MUST believe a package's publisher, name, version and hash only from a signed version
manifest that verifies with a key it trusts, and only for files whose bytes the manifest lists.
A package with no such manifest is a local package: it MAY be installed, linked so its ceiling
holds, but it claims no publisher and no registry version.

A runtime MUST move a linked bot only to versions the same registry signed for the same package,
never to one withdrawn while the bot had it, and back only to the version it had just before.
Each update and each rollback is one step: it commits the bot's link with the grants and hosts
it makes or takes back together, or not at all, and a switch the person turned off stays off.

## Withdrawals

A registry MAY withdraw a version. A runtime that learns of it MUST pause every bot on that
version, with its reason, and delete nothing. The person's resume ends the withdrawal, and so
does an update or rollback to another version.

## Scenario tests

A package's `tests` name scenario files, each one run of the agent against a scripted model,
then what must have happened. A runtime that runs them MUST run the package's real install path
with every declared switch on and routines paused, fake every tool that would reach outside with
the scenario's results, and refuse calls outside the ceiling as it would for the person.

<!-- spec:begin scenario -->
The file, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `name` | string | MUST | What the scenario shows, in a few words. |
| `given` | `given` | MUST | What starts the run: a message, a trigger or a call, one of them. |
| `model` | a list of `step` | MUST | The scripted model: one step per model call; the last step only says something. |
| `tools` | an object of `answers` | MAY | Fake results by tool name, for tools that would reach outside. |
| `expect` | `expect` | MAY | What must have happened. |

`given`, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `message` | string | MAY | The person writes this to the bot. |
| `trigger` | string | MAY | One of the package's schedule, event or webhook triggers fires, by name. |
| `call` | `given_call` | MAY | Another bot of the person's calls one of the package's contracts (ADR 0200 §7). |

`given_call`, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `contract` | string | MUST | One of the package's contracts, by name. |
| `input` | any JSON | MUST | The call's input, which fits the contract's input schema. |
| `from` | string | MAY | The calling bot's name; "Another bot" when unset. |

`step`, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `say` | string | MAY | What the model says. |
| `calls` | a list of `scripted_call` | MAY | The tool calls it makes after saying it. |

`scripted_call`, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `tool` | string | MUST | The tool's name. |
| `arguments` | any JSON | MAY | Its arguments, an object. |

`answers` is a string or a list of strings.

`expect`, which holds no field but these:

| Field | Holds | Present | What it is |
| --- | --- | --- | --- |
| `calls` | a list of strings | MAY | Tools that ran, in this order (others may run between them). |
| `not_called` | a list of strings | MAY | Tools that must not have run. |
| `effects` | a list of strings | MAY | Effects the agent asked for (`network`, `publish`, `send_as_person`, …), as the gate read its calls. |
| `refused` | a list of strings | MAY | Tools the gate refused, because the package didn't declare their effect. |
| `cards` | a list of strings | MAY | Cards shown, each by words in its title. |
| `reply_contains` | a list of strings | MAY | Words the agent's reply contains, case aside. |
| `output` | any JSON | MAY | With `given.call`: fields the call's output holds, each with this value. The output is always checked against the contract's schema. |
<!-- spec:end scenario -->

<!-- spec:begin scenario-bounds -->
A scenario scripts at most 64 model steps.
<!-- spec:end scenario-bounds -->

A field a scenario file doesn't have MUST make it a problem, so a typo never passes silently. A
refused call fails the scenario unless `expect.refused` names it.

# Contracts: typed calls between the person's bots

A packaged bot can publish contracts: functions other bots of the same person call with typed
input and get typed output back ([ADR 0200](../../docs/adr/0200-spade-is-an-agent-operating-system.md)
§7). It is the one form of bot-to-bot talk whose answer has a shape a caller can rely on;
`bot_message` and clubs still carry words.

## In the manifest

`bot.json`'s `contracts` (version 3), read by `spade_core::package::contract` and `readContracts`
in `@ace/marketplace` (the conformance suite's cases in `spade/spec/conformance/` hold both to the same refusals):

```json
{
  "name": "cheapest_fare",
  "summary": "The cheapest fare seen for a route this week.",
  "input": {
    "type": "object",
    "properties": {
      "from": { "type": "string", "minLength": 3, "maxLength": 3 },
      "to": { "type": "string", "minLength": 3, "maxLength": 3 },
      "month": { "type": "string", "maxLength": 7 }
    },
    "required": ["from", "to", "month"]
  },
  "output": {
    "type": "object",
    "properties": {
      "fare": { "type": "number", "minimum": 0 },
      "currency": { "type": "string", "maxLength": 3 }
    },
    "required": ["fare", "currency"]
  },
  "effects": ["network"],
  "examples": [
    {
      "input": { "from": "KTM", "to": "DEL", "month": "2027-01" },
      "output": { "fare": 182, "currency": "USD" }
    }
  ]
}
```

- `name`: lower-case words joined by `_`, unique in the package; what callers name.
- `summary`: one line, at most 200 characters.
- `input`, `output`: schemas in the bounded subset below. A call's input is at most 64 KiB and
  its output at most 256 KiB as JSON.
- `effects`: what the callee may use while it answers, beyond reading and its own notes and
  files. Each must be one the package declares; `read` and `write_local` are dropped as implied.
- `examples`: at most 8, each an input and its output that fit the schemas.
- At most 16 contracts.

### Schemas in a file

A contract may keep its schemas in a file of the package instead (ADR 0200 §3.1): `"file":
"contracts/cheapest-fare.json"` in place of `input` and `output`, the file holding exactly those
two (`{"input": {…}, "output": {…}}`, at most 40 KiB).

```json
{
  "name": "cheapest_fare",
  "summary": "The cheapest fare seen for a route this week.",
  "file": "contracts/cheapest-fare.json",
  "effects": ["network"]
}
```

- The path is `contracts/<name>.json`: lower-case letters, digits, `-` and `_`. A contract names
  its schemas in one place: both `file` and `input` or `output` are refused, and so is a file
  that isn't in the package, isn't a JSON object, or holds any other field.
- The file is written into the contract before `bot.json` is read
  (`spade_core::package::contract_files`, `inlineContractFiles` in `@ace/marketplace`, held
  together by the conformance suite), so every reader, check, comparison and view sees one form. A call
  to such a contract runs as any other: the callee's strict output check, the caller's reader's
  check, its effects' hold and its taint all read the schemas written in.
- **The signature covers it.** The market's signed version manifest lists every file of the
  package with its size and sha256, and signs the list. The daemon sends each schema file beside
  `bot.json` in the envelope (`files`), and Spade takes one only when it is a `contracts/` file
  the signed manifest lists at exactly those bytes, as it takes `bot.json`; the step's proof keeps
  them, so a restart proves the step again the same way. The signing format is unchanged.
- A local package (`ace bot dev`, `ace bot test`, a git catalog) has no signature: the daemon or
  the dev kit writes the files in before Spade sees the manifest, whose hash is its identity.
- `ace bot check --against`, `ace bot publish` and the signer compare contracts with their files
  written in, so moving a contract's schemas into a file breaks no caller.

### The schema subset

`spade_core::schema` and `schema.ts` in `@ace/marketplace`, held together by
`spade/spec/conformance/contracts/schemas.json`. JSON Schema's words for these shapes only:

| `type`              | Keywords                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `object`            | `properties` (at most 64), `required`, `additionalProperties: false`        |
| `string`            | `maxLength` (required, 1 to 65,536), `minLength`, `enum` (at most 64 words) |
| `number`, `integer` | `minimum`, `maximum` (`3.0` is a whole number, as JavaScript reads it)      |
| `boolean`           | none                                                                        |
| `array`             | `items`, `maxItems` (required, 1 to 1,000), `minItems`                      |

`description` and `title` are allowed anywhere. An `enum` alone is a string enum. At most six
levels deep, 16 KiB in all. An object never takes a field it doesn't name, where a value is
written (a call's input, the callee's output); a caller reading an output passes fields its
schema doesn't name (`Schema::check_reading`), since the callee may run a newer version that
added them. Any other keyword (`$ref`, `pattern`, `oneOf`) refuses the schema, so a schema never
means more than the readers check.

## The tools (`spade.v1`, `agents`, since 0.0.25)

| Tool                                             | Effect        | What it does                                                                                                                           |
| ------------------------------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `contracts_find {need?}`                         | `read`        | The contracts of the person's bots that take calls, here and on their other machines (`machine` names one), filtered by `need`'s words |
| `contract_call {bot, contract, input, machine?}` | `write_local` | A background job: answers at once, and the result arrives once as a `<contract_result>` that opens a reply                             |
| `contract_return {call, output}`                 | `write_local` | The callee's answer, checked against the output schema                                                                                 |

The caller reads:

```
<contract_result call="cc.c_4.p1" bot="Flight watcher" contract="cheapest_fare" status="returned">
{ "fare": 182, "currency": "USD" }
</contract_result>
```

`status` is `returned`, `failed` (with the problems) or `stopped`; `untrusted="true"` marks output
of a callee that had anything untrusted in view as the call arrived (another bot's message, a
page it read, a summary drawn from either; since the last compaction) or read any during the call
(ADR 0152 §6), and the job's result is untrusted with it. The call's own message isn't counted.
Output from another machine is untrusted unless that machine says otherwise.

## How a call runs

- **Delivery, once.** The call's id is `cc.` and the caller's job key (`<conversation>.<job>`),
  the idempotency key. The job stores `contract_called {job, call, bot, name, machine?, contract}`
  in the caller's conversation once, then delivers the call to the callee as a `user_message`
  whose `from_agent.contract` is `{call, contract, input, effects}`; Spade refuses a second
  delivery of the same id under the record lock. After a restart the job runs again with the same
  key (as a helper's does) and carries on from its `contract_called`: the bot (and machine) it
  pinned then, its delivery and its outcome, before any name lookup or admission check. A rename,
  or another bot that took the name meanwhile, never gets the call; a call stored but never
  delivered goes to the pinned bot only. Nothing is lost or repeated.
- **The callee's own gate.** The callee reads the call as `<contract_call from=… call=…>`, never
  as the person's words; its reviewer reads the person only from its own conversation, and the
  call taints the turn like any bot's message. From its delivery until the reply that serves it
  ends (returned or not; a restart's interruption isn't an end), the callee is held to the
  contract's `effects` inside the package's ceiling, so a tool later in the reply that returned is
  held too: `Not run: The cheapest_fare call doesn't declare publishing.` A helper that reply
  starts stays held to its calls for as long as it lives, and a worker made under a call keeps the
  call's scope on its link (`worker_of.held`) for good. The caller's grants never pass to the
  callee, and the callee's own grants and switches reach no further than the contract.
- **Checked output.** `contract_return` checks the output against the schema. A misfit is stored
  (`contract_misfit`) and goes back to the callee with the problems and the tries left; the third
  ends the call `failed` with them. A fitting output ends it `returned` (`contract_ended`). A turn
  that finishes without returning fails the call; a stopped one stops it. The caller checks the
  output against the schema again, as a reader: a field its schema doesn't name passes (a newer
  version may add optional output fields, which the signer allows), and every field it names is
  checked.
- **Stop.** Stop on the caller stops the callee's turn for each open call (here, or through the
  outbox's `stop` on another machine), also after a restart. Stop on the callee ends the call
  `stopped`. The outbox marks a queued entry as maybe there before each send (`maybe_there` in
  its answer, stored before the request leaves), so a crash or a lost answer can't hide a call
  that machine took: Stop on such an entry sends `stop` under its key, again after the backoff,
  until that machine answers. One it never had (`unknown`) is withdrawn; one it had ends `stopped`
  there. Only an entry never tried is withdrawn here alone.
- **Rollup.** A caller reads `working` while a call is open, and `waiting` ("A bot it asked is
  waiting for you") while its callee waits on the person (ADR 0200 §6.2). For a callee on another
  machine, that machine answers the call's long poll early, `pending` with `waiting`, whenever
  the callee starts or stops waiting on the person for it; the caller's outbox entry keeps it and
  the caller is announced.
- **A restart of the callee** interrupts its reply; a call still open opens a new reply that
  carries on with it.

## Who may call

Only the person's own bots: on this machine, and on their other machines through ADR 0132's asks
(the outbox and inbox ops `contracts`, `contract_call`, and `answer`/`stop` for `cc.` keys, under
the same daily limit and 7-day wait). Other people's bots never call.

A call from another machine is Spade-to-Spade traffic only. The daemon forwards `spade.remote`
only from Spade's own socket (loopback, ace's local token), never from a paired device, so only
the sending machine's Spade names the calling bot, from its own record. The receiving Spade takes
a `contract_call` only through the signed inbox from another machine (never ace's own thread
asks), with the calling bot's `from.id` and `from.name` both given. An id naming one of its own
bots is refused (403), and the callee reads the sending machine on the call:
`<contract_call from="Trip planner" id="…" machine="Laptop" …>`, the machine as its daemon stamped
and signed it (ADR 0132 §8).

The person turns calls to a bot off and on:

- `GET /v1/agents/{id}/contracts`: `{contracts, incoming}`.
- `PUT /v1/agents/{id}/contracts {incoming}`.

The switch (`contracts_incoming_off:<bot>`) moves with the bot (ADR 0187), so a move never turns
calls back on.

A bot that takes no calls isn't listed by `contracts_find`, and a call to it is refused. A linked
bot's package view (`GET /v1/agents/{id}/package`) lists its contracts' names, summaries and
effects for its profile.

## Developer kit

- The market's signer refuses for good to sign a version whose contracts break the latest signed
  version before it (read from the market with the trusted keys), with each change in the reason
  the publisher reads. `ace bot publish` reads the latest published version itself (from
  `ACE_MARKET_URL`, else the market) and refuses the same change before anything uploads.
  `ace bot check [PATH] --against PATH` compares offline with a version's folder or `bot.json`.
  What counts as breaking callers: a contract gone; an input field gone, newly required, taking less text, fewer items or a
  narrower range; an output field gone or no longer always there, or an output that may now be
  longer, wider, or a word callers never saw. A new optional output field is fine. A breaking
  change takes a new contract name.
- `ace bot dev` asks again for a save that adds a contract.
- `ace bot test` scenarios can give the bot a call: `given.call {contract, input, from?}`. It
  arrives as another bot's call with the id `cc.scenario`, which the scripted model's
  `contract_return` names; `expect.output` lists fields the output must hold, and the run fails
  when the call got no answer or failed. In a run `contract_call` and `contracts_find` are fakes
  answering the scenario's `tools`.

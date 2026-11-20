# Contracts: typed calls between the person's bots

A packaged bot can publish contracts: functions other bots of the same person call with typed
input and get typed output back ([ADR 0200](../../docs/adr/0200-spade-is-an-agent-operating-system.md)
§7). It is the one form of bot-to-bot talk whose answer has a shape a caller can rely on;
`bot_message` and clubs still carry words.

## In the manifest

`bot.json`'s `contracts` (version 3), read by `spade_core::package::contract` and `readContracts`
in `@ace/marketplace` (the shared `package/rules.json` holds both to the same refusals):

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
- At most 16 contracts. The schemas live in `bot.json` itself, so the market's signed `bot.json`
  carries them; a `file` reference alone is refused.

### The schema subset

`spade_core::schema` and `schema.ts` in `@ace/marketplace`, held together by
`spade/crates/spade-core/src/schema/cases.json`. JSON Schema's words for these shapes only:

| `type`              | Keywords                                                                    |
| ------------------- | --------------------------------------------------------------------------- |
| `object`            | `properties` (at most 64), `required`, `additionalProperties: false`        |
| `string`            | `maxLength` (required, 1 to 65,536), `minLength`, `enum` (at most 64 words) |
| `number`, `integer` | `minimum`, `maximum` (`3.0` is a whole number, as JavaScript reads it)      |
| `boolean`           | none                                                                        |
| `array`             | `items`, `maxItems` (required, 1 to 1,000), `minItems`                      |

`description` and `title` are allowed anywhere. An `enum` alone is a string enum. At most six
levels deep, 16 KiB in all. An object never takes a field it doesn't name. Any other keyword
(`$ref`, `pattern`, `oneOf`) refuses the schema, so a schema never means more than the readers
check.

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
of a callee that read anything untrusted during the call (ADR 0152 §6), and the job's result is
untrusted with it. Output from another machine is untrusted unless that machine says otherwise.

## How a call runs

- **Delivery, once.** The call's id is `cc.` and the caller's job key (`<conversation>.<job>`),
  the idempotency key. The job stores `contract_called {job, call, bot, name, machine?, contract}`
  in the caller's conversation once, then delivers the call to the callee as a `user_message`
  whose `from_agent.contract` is `{call, contract, input, effects}`; Spade refuses a second
  delivery of the same id under the record lock. After a restart the job runs again with the same
  key (as a helper's does), finds its call and waits for its end; nothing is lost or repeated.
- **The callee's own gate.** The callee reads the call as `<contract_call from=… call=…>`, never
  as the person's words; its reviewer reads the person only from its own conversation, and the
  call taints the turn like any bot's message. While the call is open (delivered, not ended, no
  reply ended since; a restart's interruption doesn't count), the callee and its helpers and
  workers are held to the contract's `effects` inside the package's ceiling:
  `Not run: The cheapest_fare call doesn't declare publishing.` The caller's grants never pass to
  the callee, and the callee's own grants and switches reach no further than the contract.
- **Checked output.** `contract_return` checks the output against the schema. A misfit is stored
  (`contract_misfit`) and goes back to the callee with the problems and the tries left; the third
  ends the call `failed` with them. A fitting output ends it `returned` (`contract_ended`). A turn
  that finishes without returning fails the call; a stopped one stops it. The caller checks the
  output against the schema again.
- **Stop.** Stop on the caller stops the callee's turn for each open call (here, or through the
  outbox's `stop` on another machine), also after a restart. Stop on the callee ends the call
  `stopped`.
- **Rollup.** A caller reads `working` while a call is open, and `waiting` ("A bot it asked is
  waiting for you") while a callee on this machine waits on the person (ADR 0200 §6.2).
- **A restart of the callee** interrupts its reply; a call still open opens a new reply that
  carries on with it.

## Who may call

Only the person's own bots: on this machine, and on their other machines through ADR 0132's asks
(the outbox and inbox ops `contracts`, `contract_call`, and `answer`/`stop` for `cc.` keys, under
the same daily limit and 7-day wait). Other people's bots never call. The person turns calls to a
bot off and on:

- `GET /v1/agents/{id}/contracts`: `{contracts, incoming}`.
- `PUT /v1/agents/{id}/contracts {incoming}`.

A bot that takes no calls isn't listed by `contracts_find`, and a call to it is refused. A linked
bot's package view (`GET /v1/agents/{id}/package`) lists its contracts' names, summaries and
effects for its profile.

## Developer kit

- `ace bot check [PATH] --against PATH` (and `ace bot publish --against`) compares the contracts
  with the version other bots call (its folder or `bot.json`) and refuses a change that breaks
  them: a contract gone; an input field gone, newly required, taking less text, fewer items or a
  narrower range; an output field gone or no longer always there, or an output that may now be
  longer, wider, or a word callers never saw. A new optional output field is fine. A breaking
  change takes a new contract name.
- `ace bot dev` asks again for a save that adds a contract.
- `ace bot test` scenarios can give the bot a call: `given.call {contract, input, from?}`. It
  arrives as another bot's call with the id `cc.scenario`, which the scripted model's
  `contract_return` names; `expect.output` lists fields the output must hold, and the run fails
  when the call got no answer or failed. In a run `contract_call` and `contracts_find` are fakes
  answering the scenario's `tools`.

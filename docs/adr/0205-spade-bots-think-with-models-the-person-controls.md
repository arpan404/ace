# 0205: Spade bots think with models the person controls, not only coding subscriptions

Status: accepted. Date: 2026-11-20. Decided by: the founder (2026-11-20), taking every
recommendation below. Builds on [ADR 0002](0002-local-cli-providers.md) (providers through the
person's own CLIs), [ADR 0119](0119-spade-endpoint-keys.md) (endpoint keys in the keychain),
[ADR 0133](0133-spade-cli-brains.md) (subscriptions through CLIs),
[ADR 0162](0162-spade-model-routing.md) (models per role) and [ADR 0053](0053-queue-and-recovery.md)'s definite-signal rule
for moving work. Amends ADR 0133 decision 1 (how the picker offers subscriptions).

## Context

A bot can think with three kinds of model today:

- **An endpoint**: any server speaking the `openai-chat` or `anthropic` format, with its key in
  the OS keychain or an environment variable (0119). Presets ship in `spade/config/models.json`.
- **A local server**: Spade finds a server on this computer that speaks the `openai-chat` format
  (`GET /v1/endpoints/local`) and adds it as a keyless endpoint.
- **A subscription through a CLI** (`cli:<provider>/<model>`, 0133): ace's daemon runs the turn in
  the person's own signed-in coding CLI, read-only, and the bot's tools come through ace's MCP
  endpoint.

Subscriptions feel free to the person, so they are attractive as a bot's brain. They are also a
risk:

- Coding subscriptions are sold for coding with the vendor's tool. Using one to run a standing
  bot all day may fall outside what the vendor allows, and terms change without notice. ADR 0002
  records vendors that already forbid hosted or third-party use of their logins.
- A CLI can change its output or its read-only mode in any release. A bot that depends on it
  stops when it does.
- A paid Spade plan that only works on someone else's subscription has no floor.

Model vendors also bundle hosted agents into those same subscriptions. Spade can't win by being a
cheaper way to spend them. It wins by running on whatever model the person controls, local ones
included, and saying plainly what each one costs and risks.

## Options considered

- **Remove CLI brains.** Safest for terms. Takes away a working option people like. Rejected.
- **Keep everything as is.** Leaves the terms risk unpriced and the default unclear. Rejected.
- **Make endpoints and local models the default path, keep CLI brains as an informed opt-in
  per bot, route by role with fallbacks on definite signals, and ship a terms record per CLI
  provider that can turn new use off.** Chosen.

## Decision

### 1. What Spade offers first

- **First run and New bot** offer, in this order: a local model if one is running here, the
  person's endpoints, then "Add a model" (an endpoint preset or a local server). Subscriptions are
  listed last, under "Your coding subscriptions", and are never picked by themselves: not as the
  first usable model (agents.md), not for a template, not as a fallback.
- **Choosing a subscription for a bot** shows, once per provider, what it means: "This bot will
  run in your <provider> CLI on your subscription. Its maker's terms apply to how you use it. If they
  change, Spade may stop offering it." The person ticks Use it. Stored per provider as
  `cli_terms_ack:<provider>` with the date and the terms record's version (section 4).
- Packages keep naming only `fast` or `capable` (0200 §3.3). A package can never ask for a
  subscription.

### 2. Routes: a role is an ordered list

ADR 0162 gives each role one model. A role becomes a **route**: up to four models in order.

```json
{
  "roles": {
    "main": ["local/model-l", "work-endpoint/model-a"],
    "fast": ["local/model-s", "work-endpoint/model-b"]
  }
}
```

- **The first model that can serve the call serves it.** A model can serve a call when it has
  every capability the call needs (`tools`, `images`, the context the prompt needs, as models.json
  lists) and is reachable.
- **Fallback only on definite signals**, as ADR 0053 holds for moving work: the endpoint is
  unreachable (connection refused, DNS failure, TLS failure), answers 429 or a quota error, or
  answers 5xx three times with backoff. Never on a slow answer, a bad answer or a refusal. The
  step records which model served it and why the earlier ones didn't, and the reply shows "Ran on
  model-b: the local server was off."
- **A conversation stays on one model while its cache is warm**, as ADR 0162 does for compaction:
  a fallback for one call doesn't move the next call back and forth. The route is read again at
  the next reply.
- **Subscriptions never appear in a route** other than as a bot's own `main` choice, alone. A
  failing subscription turn fails as 0133 says; Spade never falls back from a subscription to a
  paid endpoint, or the other way, without the person.
- `GET`/`PUT /v1/models/roles` take a list or a single model (read as a list of one), so older
  clients keep working.

### 3. Local models as a first-class path

- **Found and added in one step**, as today, from any server on loopback that speaks the `openai-chat` format.
- **Capabilities are measured, not guessed.** When a local model is added, Spade sends three
  fixed probes: a plain answer, one tool call against a fake tool, and a structured answer
  against a small JSON Schema. The results set its `capabilities`. A model that can't call tools
  can serve only `title` and `compact`, and the picker says why: "This model didn't call tools in
  Spade's check, so it can't run a bot." The probes run on the person's machine against their own
  server and cost nothing.
- **Known-good local models.** `spade/config/models.json` gains a `local` list: model families
  ace has run its first-party packages' cases on (ADR 0204), on its own machines, with the share
  that passed. The picker marks them "Works well with Spade's packages". ace measures them on
  local models only, which spends no one's quota.
- **A package's needs are checked against the route.** A package whose bot uses `apps` or
  `agents` needs `tools`; the install review warns when no model in the person's `fast` or
  `capable` route has it.

### 4. A terms record per subscription

- `spade/config/cli-terms.json`, shipped with each build, holds one entry per CLI provider:
  `{provider, status, checked, source, note}`. `status` is `allowed` (the vendor's terms or a
  written answer permit a person's own standing agents on their own subscription), `unclear`, or
  `refused`. `source` is the address of the terms read, `checked` the date.
- **What each status does:**
  - `allowed`: offered as section 1 says.
  - `unclear`: offered, and the acknowledgement says "Its terms don't say whether this is allowed."
  - `refused`: not offered for new bots. Bots already on it get a card, once: "<provider>'s terms no
    longer allow this. Pick another model for this bot." with the person's routes as one-tap
    choices. The bot's next CLI turn doesn't start until the person picks; messages wait. Nothing
    is switched without the person, because a switch can move cost from a subscription to a paid
    endpoint.
- **A change between builds** reaches devices as a signed notice: the market's signer signs
  `GET /v1/notices`, a list of `{provider, status, note, at}`, with the market keys (0168 §6). The
  daemon reads it with the daily update check. A notice can only make a status stricter than the
  shipped record; loosening needs a build.
- **The first records** are written from each vendor's current terms, with the source linked,
  before this ships. Until a provider's record is written, it reads `unclear`.

### 5. The paid plan never depends on a subscription

Everything a paid Spade plan sells (product plan M4, M6) must work on endpoints and local models
alone. Its tests run on those. A subscription is the person's own extra.

### 6. Phases

1. **First slice.** The picker's order; the acknowledgement; `cli-terms.json` with every provider
   at `unclear` until written; `refused` handling with the card; subscriptions out of the first
   usable model and templates.
2. **Routes.** Roles as lists; fallback on definite signals; the step's served-by record and the
   reply's line.
3. **Local models.** The capability probes; the `local` list measured on ace's cases; the install
   review's warning.
4. **Signed notices** for terms changes.

## Decided

The founder took each recommendation on 2026-11-20.

1. **Subscriptions stay, as an informed opt-in per bot**, last in the picker, never automatic.
2. **A terms change never switches a bot's model by itself.** The bot waits for the person.
3. **Fallback is on definite signals only**, never from a subscription to a paid endpoint.
4. **Notices can only tighten.** Loosening a provider's status needs a new build.

## Consequences

- A bot keeps working when one model goes away, if the person gave it a route.
- Spade can be sold on what it does, whatever the person's subscriptions allow.
- Local models get a real path, with honest labels, which suits privacy-sensitive buyers.
- Some people will see more friction choosing a subscription, on purpose.
- ace takes on reading vendors' terms and keeping the records current. A wrong `allowed` is ace's
  mistake to fix by notice.

## Tests

- The picker: with a local server and a subscription available, the first usable model is the
  local one; a template never gets a `cli:` model; choosing a subscription without the
  acknowledgement is refused by the API.
- Routes, on `spade-testkit`'s fake endpoints: a refused connection on the first model serves the
  call on the second and records why; a slow answer or a bad answer doesn't fall back; a 429 does;
  the next call of a warm conversation stays on the model that served it; a route never adds a
  `cli:` model.
- Terms: a `refused` record keeps new bots off that provider and holds an existing bot's next CLI
  turn until the person picks; a signed notice that loosens a status is ignored; one with a bad
  signature is ignored.
- Local probes against a test server that can't call tools: the model is limited to `title` and
  `compact`, and a bot can't pick it as `main`.

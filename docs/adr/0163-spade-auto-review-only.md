# 0163: Spade has one access level, the auto-review

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15: Spade has only one access
mode, auto-review; Ask and Full access go). Amends [ADR 0144](0144-spade-autonomous-bots.md)
decisions 1–5, 7 and 8; amended by its own amendment 1 (payments and sends go to the person) and
amendment 2 (Full access comes back as an opt-in mode, with the hard stops first).
Follows the research behind the Spade harness audit (a reviewer that
never sees the bot's own text; refusals go back to the bot; repeated refusals go to the person).

## Context

ADR 0144 gave each bot one of three levels. `ask` put every write in front of the person, which
is the approval fatigue the auto-review was built to end; `full_access` ran everything with no
check at all, which no layer of Spade can make safe while the shell classifier is a guard rail
and not a sandbox. Under `auto_review`, a fixed list of kinds (payments, sending as the person,
publishing, deletes outside the folder, unknown tools, a long list of shell findings) went
straight to the person, so most of what a working bot does outside its folder still asked. The
choice itself was one more thing for the person to get right per bot.

## Decision

1. **One level.** Every bot is on the auto-review. `access` is no longer a choice: the API
   refuses any value but `auto_review` with `400` (`access must be auto_review: …`) on
   `POST /v1/agents` and `PATCH /v1/agents/{id}`, and `auto_review` changes nothing. Agents still
   show `"access": "auto_review"`, so a client from before reads the level rather than taking a
   missing one for `ask`.
2. **Everything the gate would hold goes to the reviewer** (the `review` model role of
   [ADR 0162](0162-spade-model-routing.md)). What used to always ask the person is reviewed, and
   the rule that singled it out is in the reviewer's prompt as `<concern>`: a payment, a message
   as the person, publishing, a delete outside the folder, changing sign-ins or access, a tool
   Spade can't classify, each shell finding, an app tool that claims to read but says it acts,
   an outward call or a routine set up after untrusted content. The reviewer is told to refuse
   what needs the person's say unless their messages plainly ask for exactly it, and to be
   stricter after untrusted content.
3. **The reviewer approves or refuses.** Its typed answer is
   `{verdict: approve | refuse, reason, retries_refused}`. `approve` runs the call. `refuse`
   returns `Not run: <reason>` to the bot as the call's result (not an error), telling it not to
   work around the refusal; there is no `escalate` verdict and no `outward_or_irreversible` rule.
4. **The person is asked in two cases only.**
   - **The bot tries a refused step again.** Counted from the person's latest message: the same
     tool with the same arguments as a refused call, a step the reviewer marks `retries_refused`
     (it is shown up to five refused steps with their reasons), or the third refusal in a row
     with nothing run, approved or asked in between. The bubble's `reviewer_reason` is
     `Refused again: <reason>`.
   - **The review can't decide.** A reviewer that fails, times out (60 s), answers what doesn't
     parse, or finds the bot at its cap; a call too long for the reviewer to read whole; a
     script the reviewer can't be shown. An unreviewed call never runs.
5. **Unchanged.** Credentials are refused before any review and never put to the person (those
   refusals don't count toward a retry). Reads and calls the person allowed "always" run, except
   an app tool that claims to read but says it acts and standing work set up after untrusted
   content, which are reviewed. The ADR 0135 review of calls the gate runs stays a separate,
   optional setting. Approvals bound to file hashes, taint since compaction, task continuation
   and the caps are as in ADR 0144.
6. **"Always allow" stays.** The person's Always allow on a raised request is their explicit
   grant for that tool and scope, and it still lets later calls run without review. Grants a
   person gave under `ask` were the same explicit choice and stay too; nothing served only the
   removed levels except the level choice itself.
7. **Stored levels move forward.** `access_changed` events naming `ask` or `full_access` (and any
   word this build doesn't know) read as `auto_review`. Once, on the first start of this build,
   every conversation whose latest stored level is `ask` or `full_access` gets an
   `access_changed` to `auto_review`, so the activity log shows the move; the setting
   `access_levels_retired` records that it ran and `access_levels_pinned` is removed.
8. **Clients.** The web app's access choices go: the profile's access row, the new-bot line's
   access part and the Full access confirm. A raised request still shows as the request card.

## Amendment 1: spending money and sending as the person are the person's (2026-11-15)

Decided by the owner (2026-11-15). Decision 2 put every held call before the reviewer; two kinds
now never go to it:

- **Spending money:** payments, purchases, bookings that charge, transfers.
- **Sending as the person:** email, messages, posts or comments sent in their name or from their
  accounts.

A call Spade classes as either goes straight to the person as a raised request card. No reviewer
is asked, so none can approve it, and nothing goes back to the bot first. Its `call_reviewed` is
the rules' own (`verdict: escalate`, `model: ""`) and the bubble's `reviewer_reason` is "It could
spend money, so you decide." or "It sends something in your name, so you decide." This holds for
workers and helpers too: their calls go through the same routing. Credentials are still refused
before it. The person's Always allow (decision 6) on such a request still lets later calls of
that tool and scope run without asking. Publishing, deletes outside the folder and every other
concern stay with the reviewer.

Classification is the existing one (`spade_core::autonomy::classify` and the shell classifier),
extended:

- posts and comments from an app count as sends (`create_post`, `add_issue_comment`), and so
  does `gh pr|issue comment`; a message noun with another verb (`delete_comment`,
  `archive_email`, `create_draft`) no longer reads as one;
- `booking`, `reserve`, `reservation`, `withdraw`, `payout` and `remit` read as payments;
- an app tool marked read-only whose name or description says it pays or sends is classed as
  that, so it reaches the person rather than the reviewer;
- ace's own tool names never make a payment or a send (`agent_message`, `transfer` act on
  ace); a `browser_*`, `screen_*` or `sim_*` call told to press or type a purchase button
  (`Place order`, `Buy now`, `Checkout`…) is a payment. A click on an element by its id alone
  can't be classed and stays with the reviewer.

Consequence: the first bullet of Consequences no longer holds for payments and sends; a
publish can still run on the reviewer's approval alone. Tests: the routing table in
`spade_core::autonomy`; through the API, a payment and a send never run on a reviewer's approval
and reach the person (the send's Always allow then holds), a worker's payment reaches the
person, and a publish is still reviewed.

## Amendment 2: Full access, opt-in per bot, with the hard stops first (2026-11-18)

Decided by the owner (2026-11-18). Decision 1 made the auto-review the only way a bot decides.
Since then ADR 0167 and ADR 0171 built the containment the auto-review was standing in for (the OS
sandbox, typed tools that hold the person's sign-ins, effects declared once, places for driving),
so a bot whose person wants it to work without a reviewer can do that without the risks that made
`full_access` go: what Spade can't let a model or a guess decide stays the person's.

1. **A second mode.** A bot decides by the **auto-review** (every bot's default, new and existing)
   or by **Full access**. It is a security setting (`autonomy`, beside `commands` in
   `security:<bot>`), not the retired `access` level: stored `access_changed` words still read as
   `auto_review` (decision 7), and `access` on the agents API is still refused for anything else
   (decision 1). A word this build doesn't know reads as the auto-review and drops nothing else
   in the bot's settings.
2. **Where it is set.** `PUT /v1/agents/{id}/security/autonomy {"autonomy": "full_access" |
"auto_review" | null}` (null follows the bot above it, or the machine), and the machine's
   default `PUT /v1/security/autonomy` (Settings › Spade › Security, "How they decide"). The bot's
   security view shows the effective `autonomy`, `own.autonomy` and `full_access_confirmed`
   (set the first time Full access is turned on, so the client confirms once); the agents list
   shows `autonomy`. A worker without its own setting follows its parent, and a bot is **never
   freer than any bot above it**: a worker of a bot on the auto-review is on the auto-review,
   whatever its own setting or the machine's say. A helper decides as its bot.
3. **A pure input to the gate.** `spade_core::effect::Call` carries `mode`. `effect::route`
   applies the hard stops first, exactly as before, then, in Full access, decides in
   `effect::full_access` before anything could reach the reviewer:
   - **Refused:** a secret (`credential`, or arguments or scripts that reach sign-ins). Unchanged.
   - **Asks the person:** `pay`; `send_as_person` (messages, mail, comments, pushes, a connector
     tool declared as a send), including a push or comment a grant covers while untrusted content
     is in view (the auto-review reviews that; with no reviewer the person decides);
     `change_access`; `unknown`; a command outside the sandbox the shell classifier reads as a
     payment, a send or an access change; a driving step in a sensitive place (mail and chat,
     money, passwords, sign-in and account pages, the system's settings, social sites, a browser
     driven through the screen), on a simulator or device or an app that shows one (amendment 3
     of ADR 0171's device rule: every step there is the person's), in a place Spade can't name,
     or one ace can't hold the step to; a command asking to leave the sandbox this once; and a
     tool that declares nothing, outside the sandbox or able to reach the network, on its first
     call (ADR 0171: the person's
     answer is kept for the bot; a "yes" lets later calls run as a declared write does below,
     never past the classifier, and untrusted content in view brings it back to the person).
   - **Stays refused:** an undeclared tool the person declined for the bot.
   - **Goes to the reviewer:** a connector's or plugin's tool that writes (anything not
     read-only) and can reach the network, sandboxed or not, while untrusted content is in view,
     or while Spade's classifier is off or can't be loaded. Containing a server's files doesn't
     contain what it does over the network with a token from its configuration ([ADR
     0171](0171-spade-decides-on-effects.md), amendment 4, which applies on the auto-review too):
     only a plugin server held in the sandbox with its network off and no environment of its own
     (where tokens go) is exempt, and its tools run as the sandbox decides. The same holds for a tool that
     declares nothing: it asks on its first call unless its server is sealed that way.
   - **Runs, with no reviewer and no request:** everything else: reads, local writes, file writes
     with or without a checkpoint, commands in the sandbox, commands outside it when the bot's
     `commands` is `outside` (or the machine has no sandbox), `network` and `publish` effects of
     Spade's and ace's own tools (other bots, ace's threads, releases), an app's declared write
     when the classifier is on and doesn't raise it and nothing untrusted is in view, routines,
     tools that declare nothing inside the sandbox, and driving steps in any other app or site,
     granted or not.
   - **Untrusted content in view adds no ask** in Full access, except for an app's write (above),
     and every hard stop is decided before taint is read, so taint never turns one into a run.
4. **The classifier only raises.** ADR 0172's classifier settles nothing in Full access. On a
   call the gate let run outside the sandbox (a command with no sandbox, an app's tool), it may
   still raise to the person a call it reads as a payment, a send, an access change, a secret or
   a step in an app it can't place; the raise is stored as the call's verdict, as today. For an
   app's write it is required: with it off, those calls go to the reviewer (above). An abstain
   lets the call run. The ADR 0135 model review is skipped.
5. **The sandbox is unchanged.** Full access widens nothing: sandboxed commands stay in the
   sandbox, a per-call request to run outside still asks, and a driving step the gate let run is
   held to its place right before it runs as strictly as one the reviewer alone let run.
6. **Only the person turns it on.** Spade's bearer token is held by anything ace lets talk to
   Spade, so it can't tell the person from another process. A change that raises a bot to Full
   access (to `full_access`, or `null` when following its parent or the machine would raise it)
   and turning the machine's default on need the person's stamp: `x-ace-person:
v1.<ms>.<nonce>.<HMAC-SHA256>`, keyed with `<ACE_HOME>/spade-person.key` (written by ace's
   daemon, read by Spade from `SPADE_ACE_HOME`, never the bearer token), over the bot (or
   `machine`), the value, the time (within a minute) and a nonce Spade takes once: claimed in
   its store (`settings`, `person_stamp:<nonce>`) before the change is made, so a restart doesn't
   forget it, and pruned once older than two minutes. Without it
   Spade answers `403`; `full_access_confirmed` is set only by a stamped raise. Going back to the
   auto-review never needs one. The daemon's `spade.http` proxy stamps a raise only from a caller
   with the person's standing: the app and paired devices as they are, the host token only with
   an ace sign-in from the last ten minutes (as the market's person-only actions, ADR 0178
   §12.5), and never an agent's device (`ace-agent`, `ace-reviewer`); a raise in parts is
   refused. A bot's change is decided under the same lock as its write, against its parents
   and the machine as they are then: a parent raised meanwhile is what it is decided on. Nothing in Spade calls the setter but its person API: no tool, routine, note or
   skill. The key and Spade's token are in the credential places a bot's arguments are refused
   for, and the sandbox denies ace's data. What is left: a process outside any sandbox running
   as the person can read the key file, as it can the daemon's own token.
7. **Shown.** The bot's profile has "How it decides": Auto-review or Full access, with one
   sentence under Full access listing what still asks. Turning it on asks first, in words, the
   first time for a bot (and each time for the machine's default). The conversation's pill and
   the profile's head say "Full access" quietly while it is on. Every step still shows in the
   chat's step lines.

Consequences: a Full access bot's ordinary work outside the sandbox (a publish, a command run
outside, an app's write the classifier doesn't raise) is not looked at by a reviewer before it
runs; the person chose that for that bot. The hard stops are deterministic and come first. A command outside the sandbox is held
to them only by the shell classifier's lists and Spade's classifier, which are guard rails: a
command written to pay or send without words they know runs. Keep commands sandboxed (the
default) where that matters.

Outside the sandbox: what the binding can't promise (accepted with the owner, 2026-11-18; ADR 0171,
amendment 6). The decision on what a command shows, the person's or the reviewer's, is the
control; in Full access there is no reviewer, so for a command outside the sandbox it is the rules
and the classifier's lists. The content binding behind it (ADR 0171, amendments 5 and 6) is
defence in depth with two limits:

- It isn't race-free: another of the bot's own processes, one of its services or another app can
  change a checked file between the check at the spawn and the moment the shell opens it. The
  terminal's lock, the check after every await, and the decision are what ship against it;
  launching from immutable copies would close it and is out of scope.
- It covers bots' commands only: a plugin's MCP server and hooks are trusted when the person
  installs or enables the plugin, run contained wherever there is a sandbox, and start plainly on
  a machine without one. The enumeration tests are scoped to Spade's server crate.

Tests: `spade_core::effect::full_access` (a write outside the sandbox runs without review; a
payment, a send as the person, an access change and an unknown effect still ask; a secret is
still refused; a step on a simulator, in Mail, in a password manager or on a bank's checkout still
asks; a step Spade can't place or hold still asks; the sandbox is never widened), `security::
settings` (auto-review stays the default for new bots and bots stored before; per bot over the
machine; never freer than the bot above), `security::attest` (a stamp counts only for its bot,
value and time, once, with the shared key, and stays used after a restart), `spade-server/tests/full_access.rs` through the API
(a raise with Spade's token alone is refused, a person's stamp is taken, lowering always works, a
Full access bot holding Spade's token can't raise another bot; an undeclared sending app tool asks
first and a `network`-declared one is reviewed with the classifier off or under untrusted
content; a stamp taken before a restart is refused after it), `spade-server/tests/
sandboxed_plugin_tools.rs` (a contained plugin server with a token and its network on keeps the
app-tool rules; one sealed offline with no token runs), the daemon's `person-stamp.test.ts` and `spade-person-only.test.ts` (a host-token raise
without a fresh sign-in and an agent's raise are refused, a paired device's is stamped, lowering
is never held), and the web's `spade-full-access.test.tsx`.

## Options considered

- **Keep `full_access` behind a warning.** The owner rejected a level with no check; the caps
  and Stop bound money and time, not what a command does.
- **Keep the always-the-person list.** It sends the person exactly the calls a bot most often
  needs (sending, posting, changing things elsewhere). The reviewer sees the same rule as a
  concern, and a bot that insists still reaches the person on its retry.
- **Let the reviewer escalate.** Removed so that the person is asked for a reason they can see
  (the bot insisted, or the review couldn't run) rather than whenever a model is unsure; an
  unsure reviewer refuses and the bot can ask with `ask_user`.

## Consequences

- A payment, a send or a publish can now run on the reviewer's approval alone when the person's
  messages ask for it. The reviewer is a probabilistic layer; the OS sandbox ADR 0144 promises
  is still the containment to build.
- A hijacked bot that keeps retrying reaches the person, who still decides.
- Old clients that offer `ask` or `full_access` get a clear `400`.

## Tests

`spade_core::autonomy` (routing table, judgment, prompt) and `spade_core::autonomy::refusals`
(retries) by tables; `spade/crates/spade-server/tests/autonomy.rs` through the API: a reviewed
call runs, a refusal returns to the bot, a retried refusal asks the person, a reviewer that can't
be reached or answers what doesn't parse asks the person, and stored `ask`/`full_access` levels
read as `auto_review` and move forward once.

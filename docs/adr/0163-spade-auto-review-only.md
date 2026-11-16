# 0163: Spade has one access level, the auto-review

Status: accepted. Date: 2026-11-15. Decided by: the owner (2026-11-15: Spade has only one access
mode, auto-review; Ask and Full access go). Amends [ADR 0144](0144-spade-autonomous-bots.md)
decisions 1–5, 7 and 8; amended by its own amendment 1 (payments and sends go to the person).
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

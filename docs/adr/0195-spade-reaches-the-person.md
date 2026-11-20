# 0195: Spade reaches the person: notifications, do not disturb and an interruption budget

Status: accepted. Date: 2026-11-19. Decided by: the owner (2026-11-19: "finish the half-built
pieces": Spade's notices reach the person outside its page, with a global do not disturb, quiet
hours, an interruption budget, a morning brief, an overnight report and spend alerts). Builds on
[ADR 0012](0012-notifications.md) (ace's alerts), [ADR 0129](0129-spade-routines.md) (routines
and the heartbeat), [ADR 0160](0160-spade-wake-and-owned-services.md) (long jobs) and
[ADR 0165](0165-spade-digests-and-decision-log.md) (levels, digests, the notice stream). Amends
ADR 0165 (the morning brief) and [ADR 0166](0166-spade-has-no-spending-limits.md) (spend alerts).

## Context

Spade has served `GET /v1/notices/live` since ADR 0165, but nothing consumed it: a bot asking a
question at night, a task that stopped, a digest, a routine that found something all waited
until the person opened Spade's page. The only quiet hours were each heartbeat's own. Reaching
the person needs one path to every window and device, a rule for what may interrupt and when,
and somewhere for the rest to go so nothing is lost.

## Decision

1. **Spade decides what interrupts; ace delivers it.** Every notice on the stream now carries a
   stable `id`, a `category` (`needs_you`, `escalation`, `digest`, `routine`, `finished`,
   `brief`, `spend`, `summary`, `record`) and `reach`: `now`, `held` (with `why`: `dnd`,
   `quiet`, `budget`) or `none` (`why`: `off`, `bot_off`, `record`). The decision is pure
   (`spade_core::reach`) and made where the person's settings and history live.
2. **What reaches the person.** Approvals and questions (`needs_you`), work that stopped
   (`escalation`, level `stop`), digests, a routine or heartbeat that said something (a quiet
   heartbeat never does), a background job that ran ten minutes or more and ended, a goal the
   check found done, a worker that finished, the brief, spend alerts and the summary. Decisions
   and drafted goals stay in the digest (`record`).
3. **Do not disturb, quiet hours and the budget hold proactive notices only.** A `stop` and a
   `block` (an approval, a question the turn waits on) always get through, and so does a
   question for later in a conversation the person wrote to in the last 30 minutes. Everything
   else waits while do not disturb is on (a switch, now), inside the daily quiet window (minutes
   in the person's zone, wrapping past midnight), or once the budget is used: at most N
   proactive interruptions in the last hour and the last day (6 and 30 by default; either can
   be off). Global switch off, or the bot's own off, notifies nothing.
4. **What waits goes somewhere.** Held notices are kept (bounded to 500) and put into the bot's
   next digest as **While you were away**, and into the next morning brief. When quiet ends (do
   not disturb off, the window over), one **summary** notice says what waited through it and
   from whom; what a digest or brief already told isn't summarized again. This is the overnight
   report: a long job or tree that finishes while the person is away is held, not interrupting.
5. **One path into ace's alerts.** The daemon holds one stream to Spade while it runs and hands
   each `reach: now` notice to the notification worker (ADR 0012) as a `spade` alert, filed
   under Spade's host thread, with a `spade` target (bot, conversation, request, digest,
   category). The worker's stable ids make it one alert per notice on each device. Phones don't
   get them yet: the app doesn't read them. The stream sends what happens while it is open; a
   gap is covered by the summary and the brief, not replayed.
6. **How it shows.** Desktop: an OS notification while ace isn't in front, one per bot (a newer
   one replaces it), under a Spade switch in Settings › Notifications. Web: a toast in front,
   never for the conversation on screen; behind, one system notification across the browser's
   tabs (claimed under a Web Lock) where the person allowed them, and a Web Push opens the same
   place. More than three within ten seconds show as one line. Clicking opens the bot's
   conversation with the approval or question brought forward (`?request=`).
7. **Settings.** `GET`/`PUT /v1/reach` (`notify`, `dnd`, `quiet`, `budget`, `brief`, `spend`;
   an object's fields one by one) and `GET`/`PUT /v1/agents/{id}/reach {notify}` (`null`
   follows). In the app: Settings › Spade › Notifications, and Notify me in each bot's profile.

## Amendment to ADR 0165: a morning brief

ADR 0165 left digests at a fixed time of day out. The owner now wants one, built in and opt-in:
the **morning brief**, once a day at the person's chosen time in their zone (made up to three
hours late if Spade was down), over the time since the last brief (a day for the first). It
covers the chosen bots and clubs (a club stands for its members on this machine), or every bot
the person made. Built from events with no model call (`spade_core::reach::brief`): what
finished, each line naming the event it came from; what waits on the person now, with one-tap
answers for an approval (Allow once, Deny), a single choice and a yes/no; what waited for them;
today's scheduled routines; and spend since the last brief, by bot. Optional polish rewrites the
text once with the `title` (fast) role's model, as a digest's polish does. It is stored as a
`digests` row of kind `brief` beside the main bot's conversation, so it shows as a bubble in
Spade's main chat, never in the bot's context, and goes out as a `brief` notice.
`POST /v1/reach/brief` makes one now. Digest schedules count only `task` and `tree` rows.

## Amendment to ADR 0166: spend alerts

Spend stays information; nothing stops for it. Spade looks at each bot's spend every five
minutes: when its last hour is above both a floor ($1 by default) and `factor` (5 by default)
times its median hour over the trailing 24, it alerts once: a `spend` notice and a line in the
bot's chat (a `digests` row of kind `spend`). The episode ends when the last hour falls under
half of that line, so a rate at the line doesn't alert again. The person turns it off or tunes
the factor and floor in Settings › Spade. Spend in the app reads live: the totals in Settings ›
Spade every 30 s, each bot's on its profile with the roster.

## Options considered

- **Policy in the daemon.** The daemon would need each bot's history and settings; Spade has
  both, and runs while the daemon is away.
- **A parallel notification path for Spade.** Duplicates ace's delivery, dedup and devices.
- **Holding everything during quiet hours.** A stopped task or a waiting approval would then
  sit until morning with nobody told; the person asked that those always get through.

## Consequences

- The person hears from Spade outside its page, at most as often as they allow, and nothing
  that waits is lost.
- New: `spade_core::reach`, settings keys `reach`, `reach:<agent>`, `reach:held`, `reach:sent`,
  `reach:spend`; digest kinds `brief` and `spend`; the `spade` alert status; no new tables.
- Not built: phone delivery of Spade alerts (the iPhone app must learn the `spade` status), a
  replay of notices missed while the daemon was away, and clubs' own conversations in a brief.

## Tests

Tables in `spade_core::reach` (each category through do not disturb, quiet hours and the budget;
engagement; the summary's words; spend episodes; the brief's fold). Through Spade's API: a
question notifies once and names its request; do not disturb holds a routine but not a stop and
sends one summary when turned off; the budget sends the rest to the digest; a bot switched off
notifies nobody; the brief lists what finished overnight in the main chat, once a day; an
unusual spend rate alerts once. In ace: the worker delivers a Spade alert once and not to a
phone; the daemon follows a real stream and reopens it; the desktop router and the web rules
(nothing for the open conversation, bursts, one claim across tabs, the push's target); the
brief answers an approval in one tap.

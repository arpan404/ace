# Spade

How Spade, ace's assistant, looks and behaves on desktop and web. It follows the
[design language](design-language.md) and [DESIGN.md](../../DESIGN.md); where this file is more
specific, it wins inside Spade. The owner approved this direction on 2026-11-15.

Spade is a messenger: the person talks to their bots the way they talk to people. A bot's face
carries who it is and how it is doing; what needs the person rises off the page.

## 1. Where things live

Spade is one of ace's places. It adds no navigation of its own.

- **Rail.** ace's rail, the only one: Threads · Chats · Spade │ Code review · Automations · Skills
  … Settings · account. While a bot needs the person and they are elsewhere, Spade carries the
  8px needs-you dot.
- **List** (Spade's panel). One row per bot or club, the main Spade the first of them as an
  ordinary row. No head, no foot: the profile and Settings live in the rail.
- **Conversation** (the main column). The floating pill, bubbles, raised cards, folded steps, the
  working line and the composer. The top bar carries no title here.
- **Running** (ADR 0200 §6.3), a page in the main column at `/spade/running`: one list of every
  bot on every machine, Spade's own an ordinary row among them, in the order needs you, working,
  failed, sleeping, paused, idle. A row is the 40px face, the name, its state in words ("Checking
  fares", "Waiting on you: a question", "Paused", "Failed: …"), then one quiet line: what it
  holds open, spend today and this month, the network today and its next wake ("Held: …" while
  paused). Its workers are listed under it in words. Stop, Pause or Resume, and Open are text
  buttons. No head, no foot, no tints. It is opened from Spade's own profile (Details › Running)
  and the palette (Running bots), never from a new rail icon or toolbar button.
- **Profile** (ace's side panel). One place per bot: Details, Library, Computer. The person keeps
  talking while they change the bot, and watches its computer beside the chat. Below 680px the
  profile takes the window; on iPhone it is a sheet.
- **Settings › Spade › Apps** lists each connected app with its health (Working, Needs
  reconnect), the account, the bots that use it and when one last did, with Reconnect and
  Disconnect. A bot's Apps (in Details) offer Use <App> for apps connected already and the apps
  that fit its task, each a click from connected.
- **Settings › Spade.** General (run, model for new bots, fast, review, transcription, speech,
  Speak replies and voice, notifications, spending), Models, Web search, Apps. Notifications
  (ADR 0195): Notify me, Do not disturb, Quiet hours, Interruptions an hour and a day, Morning
  brief (its time, the bots and clubs it covers, a rewrite with the fast model) and Unusual
  spending, each a switch that applies at once.

## 2. List

- **Toolbar.** A slim row above the rows, the list's and not Spade's: Search and + as round 32px
  buttons. No marketplace button: apps, plugins and skills open from the rail's marketplace.
- **Spade.** The first row, drawn exactly as any other bot's: same row, same size, same face and
  line, same hover, open and right-click states. Its dot is its state, never "online": no dot at
  rest or while working (its eyes move), amber while it needs the person, grey while Spade is off
  on this machine (its chat then says "Turn on"). It is never pinned and never leaves the first
  place.
- **Rows.** 64px, a 40px face, the name in 14/20 at 500 and one line in 13/20. No time, no glyph
  at the end: the order already says what is recent. A development bot (ADR 0200 §9, linked to a
  package folder by `ace bot dev`) has one quiet word after its name, "Development", in 13/20 at
  400 in the subtle ink: no badge, no chip, no tint. Its Running row says the same. A bot with an accent (§7) has a 2×16px
  rule in it at the row's left edge; other rows have none.
- **Order.** Spade first, then needs you, then working, failed, finished and not seen, then the rest.
- **Row states.**

  | State              | Face           | Dot   | Line                                     |
  | ------------------ | -------------- | ----- | ---------------------------------------- |
  | Needs you          | looks up       | amber | the ask, in the needs-you text colour    |
  | Working            | moves          | none  | what it is doing, muted                  |
  | Paused             | still, asleep  | none  | "Paused"                                 |
  | Failed             | slumps         | red   | what broke, in the failed text colour    |
  | Finished, not seen | pleased        | none  | name and line in full ink                |
  | At rest            | still          | none  | the last thing it said, as plain text    |
  | Off                | still          | grey  | "Off on this Mac"                        |
  | A club             | members' faces | —     | the last speaker named, then their words |

- **Search** opens in place over the rows and finds conversations by their words. **+** holds New
  bot (⌘N), New club and Import bot.
- **Nothing below the rows.** No person, no gear: the rail holds the profile and Settings.
- **Empty:** Spade alone and one way on. **Loading:** skeleton rows at row size. **Couldn't
  read:** one sentence and Try again.

## 3. Conversation

- **The pill.** A `glass-regular` capsule floating at the top centre of the column, over the
  transcript as the composer floats under it: the bot's 28px face and name, and "Full access" in
  the quiet ink while the bot is in it. It opens the profile.
  The transcript runs to the top under it.
- **Bubbles.** The bot's on `--chat-bubble`, left, at most 64ch; the person's on `--chat-mine`
  (the accent) with `--chat-mine-foreground`, right, at most 56ch. Both 18 corners
  (`--chat-bubble-radius`), 18px sides, 10px ends, prose 15/24. Headings, lists and links render
  inside a bot's bubble; nothing is wider than it.
- **Code.** Inline code and code blocks in a bot's bubble sit on `--chat-code`. A block hangs 6px
  in from the bubble's edge at a 12 corner (concentric), with a 32px header holding the language
  and Copy, code in 13/20 mono, scrolling sideways. Inline code in the person's bubble sits on
  `--chat-mine-code`.
- **Runs.** 4px between bubbles of a run, 16px between turns. In a one-to-one chat no face sits
  beside a bubble: the pill and the working line carry it. In a club, each member's run starts
  with its face and name.
- **Time lines.** Only after a 30-minute gap or on a new day, 12/16 subtle, 24px above and 12px
  below. A routine's run names itself in its line. Times follow the person's locale, never 24-hour
  by default.
- **Working line.** Under the last bubble while the bot works: its 32px face, moving, one line of
  what it is doing and a running time. It goes when the reply ends. Only a working face moves
  (ADR 0127); every other pose moves once and holds.
- **Steps.** A reply's finished steps fold into one quiet line under its words, counted in words
  ("Ran 3 commands, changed 2 files"), that opens to each: what it did and the one thing it
  touched (a command, a path, an address), where it ran (in its sandbox or outside it) and how it
  ended. A step the person must see stands under the line unopened, in full ink: one the network
  policy blocked ("Blocked example.com: …"), the review refused or the person declined, one that
  deletes or can't be undone, and one that acted outside the bot's box (ran outside the sandbox,
  reached the network, pushed, commented, sent). Words only: no icons, badges or tints. Notes it
  saved and what it showed the person keep their own places. Helpers are one line each, opening
  to their steps. Raw markdown and raw tool arguments never show.
- **Undo.** When a reply changed the bot's files, its step line ends in the quiet words "Undo
  these changes" (the whole turn, from its first file-changing step), and each such step offers
  them too. They open a dialog that first says what goes back, which new files are removed and which
  deleted files come back (paths in mono on `--chat-well`), and what undo can't take back, then
  Undo. A step undo can't reach says so plainly in its own line, in full ink: "Can't be undone:
  it was sent in your name.", "…a payment can't be taken back from here.", "…it's published.",
  "Can't be undone here: it changed linear." The step's declared effect decides it, not its name (ADR 0167, spade/docs/security.md).
- **What it had in mind.** Under a finished reply whose message recalled notes, one quiet line
  ("Had 2 notes in mind") opens to them; each opens where it's from.
- **A failed run** says where it happened and offers the way out, in the bubble's place.
- **Raised card** (an open question or request, and only those): `--chat-raised`, its edge and
  lift (`shadow-chat-raised`), 18 corners, 20px padding, at most 600px. The amber needs-you glyph
  marks its first line; several questions show ‹ 1/2 › in that line (`QuestionPager`). One accent
  primary at the footer's right, a pill: Send (⌘↵), Next before the last question, Allow (↵, Esc
  denies). Quieter answers are ghost words on the left. Fields and options sit on `--chat-well`.
  A refused answer says why under the field.
- **Connect card** (a bot asking for an app, ADR 0131 amendment 1): a raised card whose first
  line is the app's mark and name, with "<Bot> asks to use it" (or that its sign-in ended); the
  bot's reason; "<Bot> will be able to:" and the catalogue's lines; one quiet line that the person
  signs in on the app's own page. One primary in words: Connect <App>, Add a key (its two steps
  and a field inline), Use <App> or Reconnect <App>; Later and Not now as ghost words; "Let every
  bot use <App>" as a checkbox. While signing in, one line says what to do in the browser, with
  Cancel; a failure says what fixes it. Connected, it settles to one quiet line with the mark
  ("Connected as ada@example.com"); an app not available yet is the bot's bubble with "Not
  available yet", and nothing waits.
- **Settled cards.** An answered question becomes a quiet bot bubble, the answer the person's own
  bubble. A request becomes one line ("Allowed · curl -s …"); in a run, they fold into the reply's
  steps. Left for later, a card folds to one line in place with Answer, and one pill above the
  composer.
- **From ace (ADR 0198).** A message the person wrote in an ace thread with `@` this bot or club
  carries a quiet line above their bubble, "From ace · Fix login" (`text-xs`, muted, the whole line
  a link to that thread), and the bot's answer goes back to the thread. Nothing else marks it.
- **`@` in a Spade chat.** The same picker as a thread's: in a club, its members with their faces
  (inserted as plain `@Name`, which the club routes by), then the fleet's devices as chips. A
  device named goes to the bot as context for the work: this machine, or "Move to…" if it lives
  elsewhere.
- **Composer.** The capsule: + on the left, the field, then the trailing slot. Empty, a mic for
  dictation and a filled round voice button (the accent, 40px); typed, the filled button is Send;
  while the bot works, Stop. Waiting on the person is not working, so a card shows Send. Spade
  off is said once, above the composer. The voice button starts a hands-free conversation
  (ADR 0134, amended): while it lasts, one quiet line above the composer says where it is in
  words (Listening, Hearing you, Turning it into words, "Flights is thinking", "Flights is
  speaking · Esc to stop") with End; nothing is tinted. With no way to turn speech into words
  yet, the mic or the voice button first shows a strip with one button per endpoint that can.

## 4. Profile

- **Strip:** Share and close only. **Head:** the 96px face (its dot ringed at 14px), the name in
  22/28 at 600 (one quiet line under it: "Development" for a development bot, "Full access"
  while the bot is in it, joined by · when both), then Details · Library ·
  Computer as a segmented control in the body.
- **Details:** task (with its Earlier versions folded under it), model (one picker, grouped by
  endpoint), machine, voice (Speak replies and the bot's voice, kept on this device), routines,
  making bots (May create bots), apps, security
  (first "How it decides": Auto-review or Full access, with one sentence under Full access saying
  what still asks; turning it on asks first in a dialog, words only, the first time for that bot),
  spending, notifications (Notify me, on unless turned off for this bot), then Duplicate and
  Delete. The machine row carries Move to…, a menu of the other
  machines with Spade (an offline one named and not choosable); Spade read through a machine that
  isn't its host offers Move Spade to this machine (ADR 0187). A move, a failed move or what needs
  the person after one is one sentence above the task with its text buttons (Cancel; Try again
  and Dismiss; Dismiss), the list row says the same in fewer words. Everything edits in place: ⌘↵ saves a task, Esc puts it
  back. The face opens a popover to change it.
- **Routines** are a section of Details: schedule, webhook (its address and secret only here, with
  Copy), heartbeat, on a thread event. A row says a failed last run in words; paused reads paused.
- **Library:** notes (Spade's own starts with About you), pages, Learned from, past work, files
  and skills. A suggested note offers Keep or Dismiss; ↵ saves an edit, Esc puts it back. Each
  note (on hover, like Delete) and each page offers "Where it's from": a dialog with who wrote
  it, the conversation and the message it answered, what it had read, its trust and when, then
  Forget this, Correct this, and "Forget everything from …" for each of its sources. **Learned
  from** lists those sources (a conversation, a site, an app, an import) with what each taught,
  and Forget all behind a confirm; the person's own words are never in it.
- **Personality** (a section of Details, after Runs with): Tone (its own way, Concise, Warm,
  Formal, Playful), Humour and Emoji switches, off until turned on. Saved as each changes, taken
  from the next turn. Then **Accent** (not for Spade): "Its face's colour", then the curated
  colours (Blue, Teal, Green, Orange, Magenta, Violet) that hold 3:1 on the page, raised and panel
  surfaces of both schemes of the theme or Suit on screen; one that doesn't is left out, and with
  none left one sentence says so. A package's colour shows chosen (as "Its package's colour" when
  it isn't a curated one) until the person picks; their pick is kept through updates. A bot with
  an accent rings its 96px head face in it, 2px with a 4px gap.
- **Computer:** the surfaces it used (screen, browser, terminal) live at panel size, Activity in
  words (only exceptions stand out), and Take over only while it drives (it is at work and the
  surface is live, never live alone: Spade keeps a surface live a while after its last use);
  after that, Hand back. Idle, one quiet sentence ("Flights isn't using the terminal now.") and
  no face, button or spinner.
  While the computer starts, its small face and "Waking up…". Never used: one line.

## 5. First run, new bot and groups

- **First run.** Once Spade is on and has a model, the main Spade's chat ends in a raised card:
  four short questions, one at a time (‹ n/4 ›: what to call you, what you do, what you want help
  with, how you like to be talked to, the last with quick picks), each skippable, and Skip for
  now. The answers become About-you notes, edited later in Library › About you. Then a second
  card offers the templates as starter bots, each with Create; Done or Not now. Spade remembers
  either way.

- **New bot** is a conversation, not a form (ADR 0197): "What should this bot do?" in 22/28 at
  600 over the composer, nothing to fill in. Under the composer, the templates as chips (a 20px
  face and the name, pressed while chosen, the question becoming "What should Morning digest do
  first?"), From the marketplace when that is on, and More settings, which shows how it talks (tone, humour, emoji), the model and
  machine line on the page. Every bot starts on the auto-review, and Full access is chosen in the
  profile, never here. Import lives once, in +; a failed import is said where the bot would have
  appeared.
- **The first reply.** The bot opens as "New bot" and names itself: one quiet line, "Named itself
  Ivy", its 20px face opening the face popover and its name turning into its field, each on one
  click. Under it, the apps its task names that aren't connected ("It may need Gmail and
  Slack." and Connect apps). Then its words, at most one card of questions and a schedule
  question when the job recurs.
- **Bots it makes** (ADR 0161, amendment 1). "Made a new bot: Research · Finds and summarises
  sources" as one quiet line where it happened, with Open and Undo. Undo reads Undone, or "Archived:
  it had already acted, so it's kept and stopped". The new bot is in the list at once. "Added
  Writer to Ops" says the same of a club. The profile's Making bots section holds May create bots:
  Yes, Ask me first or No.
- **Its task changes.** "Updated its task: Also covers Slack" as one quiet line where it happened,
  with See change (the task before, struck through, and now, on `--chat-well`) and Undo, which
  reads Undone once used. A change asked of the person is a request card with the same before
  and now, Allow and Deny, never Always. The profile's task folds its Earlier versions, each with
  who changed it, why and when, and Restore.
- **Clubs:** up to 32 bots. A club's stack shows two faces and how many more ("+30") from 40px
  up. New club's member list searches once there are more than eight bots, a picked bot always
  listed. Member runs with face and name, a profile with Members and Library, New club in
  place, and @ to address a member.

## 6. Shape and buttons

Inside Spade's list, conversation and profile the shapes are softer than ace's frame; the bar, the
rail and Settings keep their own.

| What                               | Value                                          |
| ---------------------------------- | ---------------------------------------------- |
| Icon buttons                       | round, 32px, on `--hover`, `--active` on hover |
| Buttons                            | pills, 36px, `rounded-full`                    |
| Composer buttons                   | round, 40px                                    |
| Bubbles, raised card               | 18                                             |
| Code wells, menus, options, groups | 12                                             |
| Inline code                        | 4                                              |

## 7. Colour

Neutral ink everywhere. Status hues only for state: needs you, working, failed. The accent fills
the person's bubble, the one primary on a surface (Send, the voice button, a card's Next or Allow)
and checked switches. The bubble is the accent, not each bot's colour: face colours run through
the status hues, and a bubble that changed per chat would make the person look like the bot. On
Ink, ace's default accent, the bubble is solid ink. Faces keep their own colours: they are the
bots' marks.

**A bot's accent** (ADR 0200 §5.3) is one colour from its package's `style.accent` or the
person's choice in its profile. It marks only the bot's own things: its profile face's ring, its
list row's rule, its cards' title rule and, when panels arrive, its panel's header. Never a fill,
a tinted background, status, an approval, the Working line or a waiting marker. Each scheme is
checked against the live theme or Suit's surfaces at 3:1; one that fails is drawn in the face's
pair colour instead. A card's title rule always has a colour (the face's when the bot has no
accent); the ring and the row rule appear only for a bot with an accent, so a list of ordinary
bots stays neutral. Spade itself and a bot with a picture face have no pair colour, so they fall
back to nothing.

## 8. Tokens

Themed values come from `apps/web/src/theme/chat-surfaces.ts` for every theme in both schemes;
fixed sizes from `apps/web/src/styles/tokens.css`. Components read them through Tailwind
(`bg-chat-bubble`, `text-chat-mine-foreground`, `size-(--spade-list-face)`), never as literals.

| Token                                                                                     | Use                                                                                                |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--chat-bubble`                                                                           | The bot's bubble: ink 7% over the page in dark, 6% in light                                        |
| `--chat-mine` / `--chat-mine-foreground`                                                  | The person's bubble: the accent and its label                                                      |
| `--chat-mine-meta`                                                                        | Quieter text in the person's bubble, AA on the accent                                              |
| `--chat-mine-code`                                                                        | Inline code in the person's bubble, pushed away from the label                                     |
| `--chat-code`                                                                             | Code inside a bot's bubble, darker than the bubble in both modes                                   |
| `--chat-raised` / `shadow-chat-raised`                                                    | The card that needs the person: white in light, ink 10% in dark (less where quiet text would fail) |
| `--chat-well`                                                                             | Fields and chosen options inside a card                                                            |
| `--face-dot-needs-you` / `--face-dot-failed` / `--face-dot-off`                           | A face's status dot, the thread rows' colours                                                      |
| `--chat-bubble-radius`, `--chat-bubble-x`, `--chat-bubble-y`                              | 18, 18px, 10px                                                                                     |
| `--chat-code-inset`, `--chat-code-radius`                                                 | 6px, 12                                                                                            |
| `--chat-run-gap`, `--chat-turn-gap`                                                       | 4px, 16px                                                                                          |
| `--spade-round-button`, `--spade-pill-button`, `--spade-composer-button`                  | 32, 36, 40                                                                                         |
| `--spade-list-row`, `--spade-list-face`                                                   | 64, 40                                                                                             |
| `--spade-pill-face`, `--spade-working-face`, `--spade-profile-face`, `--spade-phone-face` | 28, 32, 96, 52                                                                                     |
| `--spade-profile-width`                                                                   | 360                                                                                                |
| `--face-dot`, `--face-dot-ring`, `--face-dot-lg`, `--face-dot-ring-lg`                    | 12 and 2.5, 14 and 3                                                                               |

`theme/readability.test.ts` holds them to AA: every text tier on the bot bubble, raised card,
well and code well; the person's text and meta text on the accent and their text on its code, for
every accent (Ink, the curated ones and custom ones) in every theme and scheme; and the dots at 3:1
on the list, its hover and the open row.

## 9. Kept out

The web-search nag, the All bots filter, Edit and New bot dialogs, separate routines and activity
views, hint prose, raw markdown and tool arguments, Stop while waiting, ages on rows, a glyph at a
row's end, ⋯ in the bar (Share, Duplicate and Delete live in the profile) and pills over the
composer for a new bot's settings.

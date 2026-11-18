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
- **List** (Spade's panel). The main bot's head, then one row per bot or club, then the person at
  the foot.
- **Conversation** (the main column). The floating pill, bubbles, raised cards, folded steps, the
  working line and the composer. The top bar carries no title here.
- **Profile** (ace's side panel). One place per bot: Details, Library, Computer. The person keeps
  talking while they change the bot, and watches its computer beside the chat. Below 680px the
  profile takes the window; on iPhone it is a sheet.
- **Settings › Spade.** General (run, model for new bots, fast, review, transcription, voice,
  spending), Models, Web search, Apps.

## 2. List

- **Head.** The main bot in place of a title row: its 44px face, its name in 18/24 at 600, then
  Search and + as round 32px buttons. Its dot is its state, never "online": no dot at rest or
  while working (its eyes move), amber while it needs the person, grey while Spade is off on this
  machine (its chat then says "Turn on").
- **Rows.** 64px, a 40px face, the name in 14/20 at 500 and one line in 13/20. No time, no glyph
  at the end: the order already says what is recent.
- **Order.** Needs you, then working, failed, finished and not seen, then the rest.
- **Row states.**

  | State              | Face           | Dot   | Line                                     |
  | ------------------ | -------------- | ----- | ---------------------------------------- |
  | Needs you          | looks up       | amber | the ask, in the needs-you text colour    |
  | Working            | moves          | none  | what it is doing, muted                  |
  | Failed             | slumps         | red   | what broke, in the failed text colour    |
  | Finished, not seen | pleased        | none  | name and line in full ink                |
  | At rest            | still          | none  | the last thing it said, as plain text    |
  | Off                | still          | grey  | "Off on this Mac"                        |
  | A club             | members' faces | —     | the last speaker named, then their words |

- **Search** opens in place over the rows and finds conversations by their words. **+** holds New
  bot (⌘N), New club and Import bot.
- **Foot.** The person (initials or picture, name) opens About you in Spade's Library; the gear
  beside it opens Settings › Spade.
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
- **A failed run** says where it happened and offers the way out, in the bubble's place.
- **Raised card** (an open question or request, and only those): `--chat-raised`, its edge and
  lift (`shadow-chat-raised`), 18 corners, 20px padding, at most 600px. The amber needs-you glyph
  marks its first line; several questions show ‹ 1/2 › in that line (`QuestionPager`). One accent
  primary at the footer's right, a pill: Send (⌘↵), Next before the last question, Allow (↵, Esc
  denies). Quieter answers are ghost words on the left. Fields and options sit on `--chat-well`.
  A refused answer says why under the field.
- **Settled cards.** An answered question becomes a quiet bot bubble, the answer the person's own
  bubble. A request becomes one line ("Allowed · curl -s …"); in a run, they fold into the reply's
  steps. Left for later, a card folds to one line in place with Answer, and one pill above the
  composer.
- **Composer.** The capsule: + on the left, the field, then the trailing slot. Empty, a mic for
  dictation and a filled round voice button (the accent, 40px); typed, the filled button is Send;
  while the bot works, Stop. Waiting on the person is not working, so a card shows Send. Spade
  off is said once, above the composer. Voice mode comes later: until it ships, the voice button
  is drawn but off.

## 4. Profile

- **Strip:** Share and close only. **Head:** the 96px face (its dot ringed at 14px), the name in
  22/28 at 600 ("Full access" under it, quiet, while the bot is in it), then Details · Library ·
  Computer as a segmented control in the body.
- **Details:** task, model (one picker, grouped by endpoint), machine, routines, apps, security
  (first "How it decides": Auto-review or Full access, with one sentence under Full access saying
  what still asks; turning it on asks first in a dialog, words only, the first time for that bot),
  spending, then Duplicate and Delete. Everything edits in place: ⌘↵ saves a task, Esc puts it
  back. The face opens a popover to change it.
- **Routines** are a section of Details: schedule, webhook (its address and secret only here, with
  Copy), heartbeat, on a thread event. A row says a failed last run in words; paused reads paused.
- **Library:** notes (Spade's own starts with About you), files and skills. A suggested note offers
  Keep or Dismiss; ↵ saves an edit, Esc puts it back.
- **Computer:** the surfaces it used (screen, browser, terminal) live at panel size, Activity in
  words (only exceptions stand out), and Take over only while it drives (it is at work and the
  surface is live, never live alone: Spade keeps a surface live a while after its last use);
  after that, Hand back. Idle, one quiet sentence ("Flights isn't using the terminal now.") and
  no face, button or spinner.
  While the computer starts, its small face and "Waking up…". Never used: one line.

## 5. New bot and groups

- **New bot** is a conversation, not a form: under the name, one quiet line that opens the
  profile (model and machine live there; every bot starts on the auto-review, and Full access is
  chosen in the profile, never here). Import lives once, in +; a failed import is said
  where the bot would have appeared.
- **Clubs:** member runs with face and name, a profile with Members and Library, New club in
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

## 8. Tokens

Themed values come from `apps/web/src/theme/chat-surfaces.ts` for every theme in both schemes;
fixed sizes from `apps/web/src/styles/tokens.css`. Components read them through Tailwind
(`bg-chat-bubble`, `text-chat-mine-foreground`, `size-(--spade-list-face)`), never as literals.

| Token                                                                                                          | Use                                                                                                |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `--chat-bubble`                                                                                                | The bot's bubble: ink 7% over the page in dark, 6% in light                                        |
| `--chat-mine` / `--chat-mine-foreground`                                                                       | The person's bubble: the accent and its label                                                      |
| `--chat-mine-meta`                                                                                             | Quieter text in the person's bubble, AA on the accent                                              |
| `--chat-mine-code`                                                                                             | Inline code in the person's bubble, pushed away from the label                                     |
| `--chat-code`                                                                                                  | Code inside a bot's bubble, darker than the bubble in both modes                                   |
| `--chat-raised` / `shadow-chat-raised`                                                                         | The card that needs the person: white in light, ink 10% in dark (less where quiet text would fail) |
| `--chat-well`                                                                                                  | Fields and chosen options inside a card                                                            |
| `--face-dot-needs-you` / `--face-dot-failed` / `--face-dot-off`                                                | A face's status dot, the thread rows' colours                                                      |
| `--chat-bubble-radius`, `--chat-bubble-x`, `--chat-bubble-y`                                                   | 18, 18px, 10px                                                                                     |
| `--chat-code-inset`, `--chat-code-radius`                                                                      | 6px, 12                                                                                            |
| `--chat-run-gap`, `--chat-turn-gap`                                                                            | 4px, 16px                                                                                          |
| `--spade-round-button`, `--spade-pill-button`, `--spade-composer-button`                                       | 32, 36, 40                                                                                         |
| `--spade-list-row`, `--spade-list-face`                                                                        | 64, 40                                                                                             |
| `--spade-head-face`, `--spade-pill-face`, `--spade-working-face`, `--spade-profile-face`, `--spade-phone-face` | 44, 28, 32, 96, 52                                                                                 |
| `--spade-profile-width`                                                                                        | 360                                                                                                |
| `--face-dot`, `--face-dot-ring`, `--face-dot-lg`, `--face-dot-ring-lg`                                         | 12 and 2.5, 14 and 3                                                                               |

`theme/readability.test.ts` holds them to AA: every text tier on the bot bubble, raised card,
well and code well; the person's text and meta text on the accent and their text on its code, for
every accent (Ink, the curated ones and custom ones) in every theme and scheme; and the dots at 3:1
on the list, its hover and the open row.

## 9. Kept out

The web-search nag, the All bots filter, Edit and New bot dialogs, separate routines and activity
views, hint prose, raw markdown and tool arguments, Stop while waiting, ages on rows, a glyph at a
row's end, ⋯ in the bar (Share, Duplicate and Delete live in the profile) and pills over the
composer for a new bot's settings.

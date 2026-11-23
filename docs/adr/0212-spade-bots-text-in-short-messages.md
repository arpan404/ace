# 0212: Spade bots text in short messages, and either side can reply to a message

Status: accepted. Date: 2026-11-22. Decided by: the owner (2026-11-22: "i want better chat
interface like message reply to and agents are producing too large content in one chat bubble
instead of speaking and chatting like real person"; the mechanism, the same day: "use explicit
markup in the model's output. Spade parses it to split bubbles and set reply-to ... not with a
`say` tool"). Amends [ADR 0127](0127-spade-main-bot-and-chat.md), decision 3; the rest stands.

## Context

A Spade bot answered a turn with one block of Markdown, and the chat drew it as one bubble: a
report with headings and tables in a bubble meant for a sentence. People texting each other send
several short messages, ask one thing at a time, and quote the message they are answering. Spade
had none of that: no way for the model to end one message and start the next inside a turn, no
way for the person or the bot to point at an earlier message, and nothing to keep a long report
out of the bubbles.

Two ways to let one turn send several messages were weighed: a `say` tool the model calls
mid-turn, or markup in the model's text that Spade splits on. The owner chose markup: it streams
like the text it is (a bubble fills as its words arrive, with no tool round trip), costs no
tokens of tool schema, needs no new event or approval path, and a model that ignores it loses
nothing, since text without markup reads as it always did.

## Decision

1. **Every bot is told to text like a person.** Spade's standing instructions
   (`spade_core::context::SYSTEM`, the one place every bot's prompt starts, cloud Spade's
   included) say: write like texting a capable colleague; lead with the answer in a sentence or
   two; send several short messages rather than one wall; no headings or long lists in chat; one
   question at a time; anything long (a report, a plan, a draft, a table, more than about eight
   lines) goes into a document with a line or two about it in chat. They teach the markup below
   with two short examples.

2. **The markup.** A turn's text may hold:

   ```
   <msg>Found 3 flights under €100.</msg>
   <msg reply="m7">Yes, Tuesday works. I'll hold the 9:10.</msg>
   <doc title="Lisbon trip plan">…long content…</doc>
   ```

   - `<msg>` is one chat bubble; several are several bubbles, in order.
   - `reply="<id>"` quotes an earlier message (decision 4).
   - `<doc title="…">` is long content, shown as a document card (decision 5).

   Tags are lowercase, attributes take double, single or no quotes, an open tag ends at the first
   `>` outside quotes on its line, and unknown attributes are ignored. Parsing is lenient and never
   loses text:

   - Text outside any tag becomes its own bubble; whitespace between tags is nothing.
   - A tag left open closes at the end of the text.
   - Nesting (a tag opened while another is open) or a stray closing tag makes the whole text fall
     back to plain words: every recognised tag removed, the pieces between them joined by blank
     lines, as one bubble.
   - Text with no tags reads exactly as before, one bubble per model step.
   - Nothing inside code counts: a fenced block (``` or ~~~ at a line's start, until its closing
     fence) or an inline code span on one line stays literal, so code showing `<msg>` is code.
   - While text streams, a tag still arriving at its end (`<ms`, `<doc title="Li`) is held back
     until it completes, so a tag is never drawn.
   - At most 12 messages and 3 documents per model step: later messages join the twelfth, later
     documents join the third under their title as a heading.

   The parser is pure and exists twice, because the client must split live text as it streams and
   the server must render history for the model: `spade_core::chat_markup` in Rust and
   `@ace/ui-core/spade-chat` (`chat-markup.ts`) in TypeScript. Both run one table of cases,
   `spade/docs/chat-markup.cases.json`; a change to the format changes the table first.

   **Markup is display structure only.** A message renders as the plain text it holds always did;
   a document is the same text in a document view. Neither can make a card, a button, an approval,
   a link or anything else plain text can't.

3. **Message ids.** Every message has a short id from where it is stored: `m<seq>`, the sequence
   number of its event in the conversation (a person's `user_message`, a club's `group_message`,
   the `step_finished` or reply end holding the bot's words), and `m<seq>.<n>` for the n-th
   message of that text from the second on. The ids follow from stored events alone, so the
   server and every client compute the same ones and the prompt stays byte for byte the same from
   call to call. The model reads them: the person's messages as `[m12] …`, the bot's own past
   words re-rendered with the markup and an `id` (`<msg id="m30.2">…</msg>`); old plain replies
   become one `<msg>` each. Messages relayed from a club, another bot or a routine carry no id
   in the bot's own conversation, since it can't point at them there.

4. **Reply to a message, both ways.**
   - The person: any stored message (the bot's or their own) offers Reply. The composer shows the
     quoted message in a strip (the sender's face or name and one line, with ×), and the message
     is posted with `reply_to: "m12"`. Spade looks the id up in that conversation and stores what
     it quoted on the message (`reply_to {id, text, mine, name}`, text cut to 280 characters);
     an id it can't find is dropped and the message is sent as typed. The model reads
     `[m14] (replying to your message m12: "…")` before the person's words. In a club the
     person's reply is stored on the club's message and reaches each member as
     `(replying to Quill's message: "…")`.
   - The bot: `<msg reply="m7">` quotes message m7. The client draws the quote only when m7 is an
     earlier message of the same conversation; an unknown, later or foreign id is dropped silently
     and the bubble shows without a quote. A club's members can't point at the club's messages
     (their ids belong to the club's conversation, not theirs), so their quotes drop there.
   - A sent bubble with a quote shows one small quoted line above it; clicking it scrolls to the
     original and briefly highlights it.
   - `reply_to` decodes leniently on every client: one that can't be read is ignored and the
     message shows.

5. **Long words become a document card.** A `<doc>` is a card in the chat: its title, two lines
   of preview and Open, which shows the whole text. A message the model didn't put in a document
   but that runs past about 12 lines, or holds a heading or a table (old replies, a model that
   ignores the guidance), shows as its first paragraph and the same card holding all of it.
   Nothing is ever cut off without the card.

6. **A turn is working until its last message is out.** Splitting is how the words are drawn, not
   how the turn is told. The reply stays one reply; it is open, and the bot working, until its
   reply ends, so no bubble finishing makes the turn look done (AGENTS.md priority 1). The bubble
   still filling is the live one; the working line stays under it.

7. **Chat rhythm.** A sender's consecutive bubbles sit 4px apart, the face and name once per run;
   a time line appears only after a gap of five minutes or a new day, and a bubble's time shows on
   hover. Words that go elsewhere as plain text (the list row's last line, notifications, a reply
   sent back to an ace thread or another bot, speech) have the markup removed first
   (`spade_core::chat_markup::plain`).

## Consequences

- Old conversations need nothing: plain replies read as before, and a long one gets the document
  card.
- The bot's past words read to the model with ids and normalised markup rather than exactly as it
  wrote them. Thoughts and tool calls go back untouched; only the text is re-rendered.
- The id scheme ties a message's identity to its event's sequence number, which never changes:
  Spade only appends to a conversation and deletes it whole.
- A club member can't quote a club message; the person can quote any message in a club.

## Tests

- The shared table: several messages, reply ids, unknown attributes, text outside tags, unclosed
  tags, nesting and stray closes, code blocks and spans holding tags, streaming text cut mid-tag,
  and the caps, in both parsers.
- A turn of several messages gives several bubbles in order while it streams, with the working
  line under the last until the reply ends.
- A long reply renders as its first paragraph and a document card whose Open shows all of it.
- `reply_to` round-trips: the person's reply reaches the model with the quoted words and shows
  its quote; the bot's `reply` shows its quote; clicking a quote scrolls to the original.
- Grouping and time lines follow decision 7.
- Every bot's prompt carries the guidance.

## Amendment 1: a live colleague, not a job that goes quiet

Accepted 2026-11-22, on the owner's word: bots should behave like a live colleague who is always
reachable, not a lost agent. Spade's standing instructions (`context::SYSTEM`) gain a "Staying
with the person" section, guidance in the prompt rather than any fixed line the app adds: keep
each reply short and hand long work to the background; answer the person first when they write
mid-task; say up front when something will take a while; end every reply with where things
stand; never put a big result in one answer an output limit could cut off, but write it over
several steps; and carry on after an answer that was cut short. It sits beside the narration
rule ("X is done, now Y") added the same day.

## Amendment 2: a long message folds in place instead of becoming a document

Accepted 2026-11-22, on the owner's word: "instead of docs lets make the message expand like
imessage does after 10 lines". A message past twenty lines stays a message: its bubble shows the
first twenty lines and the rest opens in place on a tap, on every client (ten at first; the owner
raised it to twenty the same day). This replaces decision
'A long reply renders as its first paragraph and a document card' (`spadeLongWords`). The
instructions say so: a long answer stays in the message with what matters first, markdown, lists
and code are fine in it, and `<doc>` is only for something the person will keep, copy or share.

## Amendment 3: reply at once, in small batches

Accepted 2026-11-22, on the owner's word: "tell agent to write smaller batch and reply
immediately ... so we can get the actual agent like feel". "Staying with the person" now opens
every reply with a short message before any tool call (naming itself when Spade asks is the one
exception), keeps each message to a sentence or two sent as soon as it is ready, and works in
short runs of a few tool calls with a line to the person between them. The narration bullet that
said the same under "How you answer" is folded into it.

# 0211. A saved session that can't open again continues in a fresh one

Status: accepted, 2026-11-22

## Context

Cursor threads run on the SDK's local runtime (ADR 0043). Each thread keeps a private
checkpoint folder with the SDK's store (and, before ADR 0043's 2026-11-22 amendment, ace's
boundary journal), and ace fences that folder when it can't be trusted: a checkpoint past its
byte budget, a history that can't be verified, or a translator whose provenance overflowed.
Every one of those guards said "use explicit bounded context handoff", but nothing did one.

On 2026-11-21 a long thread's checkpoint reached 33.5 MB, over the then 32 MiB budget. The
turn was fenced, and from then on every open failed ("SDK journal is fenced or
uninitialized", "Cursor SDK history could not be verified"). The queue held the person's
message, paused, and Retry failed the same way every time. A bigger default budget (8 GiB)
makes this rare, but any fence of this class still ended the thread.

ace already hands context to a fresh session in two places: a provider switch (ADR 0051) and
a return whose old session is gone (`abandonReturn`). Both build a bounded, cited excerpt from
ace's own transcript (`@ace/context` `portableContext`), deliver it once in front of the next
message, and let the agent page the rest with `handoff_read`.

## Decision

1. **The adapter names the failure.** An open or history check whose error says the saved
   session can never be opened again carries the code `session_store_unusable`
   (`@ace/provider-kit/open-error`). For Cursor, `store-fence.ts` reads the adapter's own
   guard messages, including wrapped ones and causes. Unsafe files (a symlink in the store) are
   never classified this way: a fresh folder beside them is not safer. Transient failures
   (sign-in, network, a checkpoint that changed during the check, a full disk) keep their codes
   and stay retryable on the same session. Since the journal and per-write quota were
   removed (ADR 0043, amendment of 2026-11-22), the size verdict comes only from the check at
   open and turn end, so momentary write pressure can never burn a generation. The advice every checkpoint fence ends with ("use
   explicit bounded context handoff") is not read as a verdict; the reason before it is.
2. **The engine hands off instead of retrying.** When a delivery or a restart continuation
   fails to open with that code, or the thread's last host fence was a checkpoint over its
   budget, the engine starts a fresh session (`store-handoff.ts`) in one transaction:
   - the thread moves to its next **store generation** (`engine_store_generations`), passed
     to the adapter as `SessionContext.storeGeneration`;
   - the native session ID and the old session's provider frames are cleared;
   - a full handoff (32 KiB rendered, the same budget as a switch) is built from the
     transcript and waits with its marker, replacing any handoff that was still waiting, plus
     a short note telling the agent this is a fresh session of the same conversation.
     It then opens once more. No model is called to summarise anything.
3. **Generations keep the old store.** Cursor's checkpoint folder for generation N > 0 is
   `<sha256(threadId)>-g<N>` beside the original. Earlier folders are never renamed or
   deleted, so their data stays available for diagnosis or a later import. ace's transcript is
   still what the person sees.
4. **Exactly once.** The queued message is not touched by the handoff: it stays in the queue
   until the fresh session takes it, with the handoff in front of it, and the handoff clears
   in the transaction that commits the provider's admission of that message. The handoff's
   quoted history leaves out the message itself, which follows it as the prompt. A crash before the commit leaves the thread as it was, so
   the next open hands off again. A crash after it reopens the fresh generation, which has no
   saved session to leave, so it is never handed off twice. A thread with no saved session (a
   fresh open that failed) is not handed off at all, and generations stop at 64, so a store
   that keeps failing ends as an ordinary failure.
5. **One quiet line.** The handoff's transcript item carries `origin.freshSession`. Clients
   draw it as one event row ("Cursor's saved session couldn't be opened again, so ace started
   a fresh one with this thread's context"), not as a switch divider and not as an error. The
   thread shows working while the handoff and the fresh open run, as for any open.
6. Retry, Resume and the automatic restart continuation all go through the same path. Retry
   only stays the last resort for failures this decision does not cover.

## Consequences

- A fenced Cursor thread continues on its own. The fresh session has none of the old
  session's private state (reasoning, open tool sessions); the agent is told so, and the rest
  is one `handoff_read` away.
- The first message after a handoff is larger, by at most the handoff budget.
- Old checkpoint folders accumulate per thread; nothing removes Cursor checkpoint folders
  today, of any generation. Each is bounded by the checkpoint budget and their number by the
  generation cap. Cleaning them up is a separate decision.
- A translator overflow (`SDK translation provenance is fenced`) is now handed off rather than
  fencing the thread, as its message always asked.
- Another provider can use the same code and `storeGeneration` without changes to the engine.

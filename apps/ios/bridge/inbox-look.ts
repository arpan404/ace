import { cardDetails, threadCard, threadGlyph } from "@ace/ui-core";
import { inboxGroup, type InboxThread } from "@ace/ui-core/mobile";

/**
 * How an inbox row reads, by the same rule as the web's Home row (`threadCard` →
 * `rowAttention`): its attention level, the status word, its tone and glyph, and whether the
 * row mutes. Only needs-you and an unseen failure are loud; live work is muted with its glyph
 * and elapsed time; a row at rest shows only its age. Swift draws this and never derives it.
 *
 * `baseline` is when this phone started following the machine: results that finished before
 * it count as seen unless the daemon marks them unread.
 */
export function inboxLook(thread: InboxThread, baseline: number, now: number) {
  const { entry } = thread;
  const settled = inboxGroup(thread, now) === "settled";
  const card = threadCard({
    entry,
    details: cardDetails(entry, undefined),
    baseline,
    settled,
    now,
    projectName: entry.details?.workspace?.name,
    unconfirmed: thread.unconfirmed,
  });
  const { level, word, tone, muted } = card.attention;
  // A word with no glyph: waiting, a failure already seen, and an unconfirmed copy.
  const bare = tone === "waiting" || level === "failed-seen" || level === "syncing";
  return {
    level,
    word: word ?? null,
    tone,
    muted,
    glyph: word === undefined || bare ? null : threadGlyph({ tone, mark: card.status.mark }),
    /** Start of the live stretch, for the elapsed time beside an active row's word. */
    since: level === "active" ? (card.status.since ?? null) : null,
    settled,
    subagents: card.subagents,
    /** A finished result not yet opened, or marked unread by hand. */
    unread: card.flags.unread,
  };
}

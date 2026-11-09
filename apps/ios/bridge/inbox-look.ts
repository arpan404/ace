import { cardDetails, rowStatusLook, rowStatusState, threadCard, threadGlyph } from "@ace/ui-core";
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
  // The desktop row's status mark (`rowStatusLook`): one icon in its state's colour, with the
  // live elapsed time for work under way, the age at rest, or a quiet word while syncing.
  const status = rowStatusLook(card.attention, card);
  // Back from a snooze, until read: the alarm alone, as the desktop row shows it; why it woke
  // is its meaning, for VoiceOver.
  const woke = card.woke;
  return {
    level,
    tone,
    muted,
    glyph: word === undefined || bare ? null : threadGlyph({ tone, mark: card.status.mark }),
    /**
     * The design language's status state (`rowStatusState`), the one word the lock screen
     * counts by: only `working` is work under way; waits and usage limits are their own.
     */
    state: rowStatusState(card.attention, status),
    /** Start of the live stretch, for the elapsed time beside an active row's word. */
    since: level === "active" ? (card.status.since ?? null) : null,
    settled,
    subagents: card.subagents,
    /** A finished result not yet opened, or marked unread by hand. */
    unread: card.flags.unread,
    /** The status icon (`RowStatusIconKind`, or `none`) and the colour it draws in. */
    icon: woke ? "woke" : status.icon,
    iconTone: woke ? "woke" : status.tone,
    /** How many agents an `agents` icon waits on. */
    count: status.count ?? null,
    /** Beside the icon: the live elapsed time, the age, a quiet word, or nothing. */
    mode: woke ? "icon" : status.mode,
    word: word ?? null,
    /** The state in a few words ("Needs approval"), for VoiceOver. */
    meaning: woke ? woke.sentence : status.meaning,
    /** Only a thread that needs the person sets its title in semibold. */
    strong: level === "needs-you",
  };
}

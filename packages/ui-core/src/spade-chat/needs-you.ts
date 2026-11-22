/*
 * One phrase for "waiting on the person" everywhere Spade shows it: what is being asked, in a few
 * words ("Asks about the hotel", "Wants to send an email"), else plain "Needs you".
 */

/** The daemon's own catch-all phrasings say nothing of what is asked. */
const generic = /^(needs you|waiting (for|on) you|asked you a question|a worker needs you)\.?$/i;

/** What a bot, worker or club waits on the person for; `ask` is its own few words, if it has any. */
export function spadeNeedsYouWords(ask?: string | undefined): string {
  const words = ask?.trim();
  return words && !generic.test(words) ? words : "Needs you";
}

/** The daemon's Running line for a bot that waits ("Waiting on you: a question") in the one phrase. */
export function spadeNeedsYouRunning(doing: string): string {
  const [, rest] = /^waiting (?:on|for) you:\s*(.+)$/i.exec(doing.trim()) ?? [];
  if (!rest) return spadeNeedsYouWords(doing);
  if (/^an? question$/i.test(rest)) return "Asks you a question";
  if (/^an? approval$/i.test(rest)) return "Asks for your approval";
  return spadeNeedsYouWords(rest);
}

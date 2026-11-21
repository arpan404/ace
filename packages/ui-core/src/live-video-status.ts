import type { LiveVideoStatus } from "@ace/protocol";

/*
 * A live view's one sentence while its video can't play (ADR 0147, X2): why, as the machine says
 * it (ace-media restarting, unavailable, or no encoder working), shared by web and the phone.
 * Words only: no icon, badge, tint or timer. Pure.
 */

/** The sentence for a screen's or device's `video` status; undefined while video plays. */
export function liveVideoSentence(video: LiveVideoStatus | undefined): string | undefined {
  // The machine writes its reasons as sentences ("ace-media" stays lower case), without the stop.
  const reason = video?.reason.trim();
  if (!reason) return undefined;
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

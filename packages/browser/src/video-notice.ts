import type { MediaUndelivered } from "@ace/protocol";
import { encoderRecovering } from "./live-video.ts";

/**
 * What a bound view's notice says (`browser.delivery`), given why it gets no pictures now (or
 * nothing, while it plays) and whether every codec it takes waits out an encoder failure's
 * cooldown. The encoder's recovery replaces only a playing view's silence or a stop ace-media
 * calls passing (which is what withdrawing its encode looks like there); anything between the
 * view and ace-media (a refusal, no connection, an update) says more and stays.
 */
export function videoNotice(
  undelivered: MediaUndelivered | undefined,
  recovering: boolean,
): MediaUndelivered | undefined {
  if (!recovering) return undelivered;
  if (undelivered && undelivered.code !== "stopped" && undelivered.code !== "starting")
    return undelivered;
  return { code: "recovering", reason: encoderRecovering };
}

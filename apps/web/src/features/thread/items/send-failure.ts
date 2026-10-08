import type { CommandPayload } from "@ace/protocol";
import { refusalMessage } from "@/lib/daemon-command.ts";

/** The daemon's limit on one message: its command, as JSON. */
export const messageLimitBytes = 256 * 1024;

const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

/**
 * Why a message wasn't sent, in words for its bubble's "Not sent" line, e.g. "Too long: 312 KB,
 * the limit is 256 KB" (`payload` lets the size be said). `code` is the daemon's refusal or the
 * client's own failure (`limit`, `storage`).
 */
export function sendFailure(code: string | undefined, payload?: CommandPayload): string {
  if (code === "message_too_large" && payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    return `Too long: ${kilobytes(bytes)}, the limit is ${kilobytes(messageLimitBytes)}`;
  }
  if (code === "limit") return "This device has too much waiting to send. Try again in a moment.";
  if (code === "storage") return "This browser couldn't save the message.";
  return code ? refusalMessage(code) : "ace didn't take it.";
}

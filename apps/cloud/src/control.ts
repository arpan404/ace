import { CipherState } from "@ace/secure-channel";
import { HostControlMessage } from "@ace/relay/wire";
import type { ControlMessage } from "@ace/relay/wire";
import type { z } from "zod";
import type { CipherSnapshot } from "./attachment.ts";

/**
 * The registration session, one message at a time from a saved cipher state, so it survives
 * hibernation between messages. Each call returns the state to save for the next message.
 */
export function sealControl(
  saved: CipherSnapshot,
  message: z.infer<typeof ControlMessage>,
): { frame: Uint8Array; next: CipherSnapshot } {
  const cipher = new CipherState(saved.key, saved.nonce);
  try {
    const frame = cipher.encrypt(new TextEncoder().encode(JSON.stringify(message)));
    return { frame, next: cipher.snapshot() };
  } finally {
    cipher.destroy();
  }
}

export function openControl(
  saved: CipherSnapshot,
  frame: Uint8Array,
): { message: z.infer<typeof HostControlMessage>; next: CipherSnapshot } {
  const cipher = new CipherState(saved.key, saved.nonce);
  try {
    const plain = cipher.decrypt(frame);
    const message = HostControlMessage.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain)),
    );
    return { message, next: cipher.snapshot() };
  } finally {
    cipher.destroy();
  }
}

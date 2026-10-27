import type { ClientCore } from "@ace/client";
import { terminalKeyBytes } from "@ace/client/terminal-keys";
import { z } from "zod";

/** One thing the person typed: text as is, or a key with the modifiers held for it. */
const Input = z.union([
  z.object({ text: z.string().max(8192) }),
  z.object({
    key: z.string().min(1).max(32),
    ctrl: z.boolean().optional(),
    alt: z.boolean().optional(),
    shift: z.boolean().optional(),
  }),
]);

/**
 * Input from the phone's terminal: keyboard text, key bar keys and hardware keys, in order,
 * gathered while the previous write was in flight. Encoded here so every client sends the
 * same bytes for the same key.
 */
export const NativeTerminalInputRequest = z.object({
  type: z.literal("terminal.input"),
  /** Omitted for a sign-in terminal, which belongs to no thread. */
  threadId: z.string().min(1).optional(),
  terminalId: z.string().min(1).max(128),
  /** DECCKM as the phone's screen last saw it. */
  applicationCursor: z.boolean(),
  input: z.array(Input).min(1).max(512),
});

/** The bytes `request` sends, in order; keys that send nothing are skipped. */
function terminalInputBytes(request: z.infer<typeof NativeTerminalInputRequest>): string {
  const modes = { applicationCursor: request.applicationCursor };
  let data = "";
  for (const input of request.input)
    data += "text" in input ? input.text : (terminalKeyBytes(input, modes) ?? "");
  return data;
}

export async function writeNativeTerminalInput(
  owner: ClientCore,
  request: z.infer<typeof NativeTerminalInputRequest>,
  signal: AbortSignal,
) {
  const data = terminalInputBytes(request);
  if (!data) return { ok: true };
  if (data.length > 8192) return { ok: false, error: "That's too much input at once." };
  return owner.request(
    {
      type: "terminal.request",
      operation: {
        op: "write",
        ...(request.threadId ? { threadId: request.threadId } : {}),
        terminalId: request.terminalId,
        data,
      },
    },
    { signal, timeoutMs: 20_000 },
  );
}

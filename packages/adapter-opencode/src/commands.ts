import { z } from "zod";
import type { OpenCodeClient } from "@opencode/client";
import type { InteractionResolution } from "@ace/protocol";
import { nativeResolution } from "./interactions.ts";

/** SDK exceptions may contain unsanitized response bodies. Expose fixed messages only. */
export async function request<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(`OpenCode ${label} failed`);
  }
}

export function resolveNativeInteraction(
  client: OpenCodeClient,
  pending: Parameters<typeof nativeResolution>[1],
  choice: InteractionResolution,
): Promise<void> {
  return request("interaction response", async () => {
    const command = nativeResolution(choice, pending);
    if (command.kind === "permission") await client.permission.reply(command);
    else if (command.cancel)
      await client.session.form.cancel({
        sessionID: command.sessionID,
        formID: command.formID,
        ...(command.message === undefined ? {} : { message: command.message }),
      });
    else
      await client.session.form.reply({
        sessionID: command.sessionID,
        formID: command.formID,
        answer: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .parse(command.answer),
      });
  });
}

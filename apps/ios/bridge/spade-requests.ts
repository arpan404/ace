import type { ClientCore } from "@ace/client";
import { SpadeRequestError } from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { segment, spadeText, type NativeSpade } from "./spade.ts";

/*
 * What the iPhone asks of Spade with an outcome it waits on: send a message, stop a reply,
 * answer an approval, turn Spade on. Every answer is `{ok: true}` or `{ok: false, title,
 * message}` in the person's words.
 */

const conversationId = z.string().min(1).max(256);

export const NativeSpadeRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("spade.send"),
    conversationId,
    text: z.string().trim().min(1).max(200_000),
  }),
  z.object({ type: z.literal("spade.stop"), conversationId }),
  z.object({
    type: z.literal("spade.answer"),
    conversationId,
    callId: z.string().min(1).max(256),
    allowed: z.boolean(),
    always: z.boolean(),
  }),
  z.object({ type: z.literal("spade.enable") }),
]);
export type NativeSpadeRequest = z.infer<typeof NativeSpadeRequest>;

type Outcome = { ok: true } | { ok: false; title: string; message: string };

const path = (id: string) => `/v1/conversations/${segment(id)}`;
const refused = (title: string, error: unknown): Outcome => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

export async function answerSpade(
  owner: ClientCore,
  spade: NativeSpade,
  request: NativeSpadeRequest,
  deps: { id(): string },
  signal: AbortSignal,
): Promise<Outcome> {
  const ask = (method: "POST" | "PUT", route: string, body?: unknown) =>
    spadeText(owner, deps.id, method, route, body, signal);
  switch (request.type) {
    case "spade.send":
      return send(spade, request.conversationId, request.text, deps, () =>
        ask("POST", `${path(request.conversationId)}/messages`, { text: request.text }),
      );
    case "spade.stop":
      try {
        await ask("POST", `${path(request.conversationId)}/stop`);
      } catch (error) {
        // 404: nothing was answering by the time Stop arrived, which is what Stop wanted.
        if (!(error instanceof SpadeRequestError && error.status === 404))
          return refused("Couldn't stop", error);
      }
      return { ok: true };
    case "spade.answer":
      try {
        await ask("POST", `${path(request.conversationId)}/approvals/${segment(request.callId)}`, {
          allowed: request.allowed,
          always: request.always,
        });
        spade.refresh();
        return { ok: true };
      } catch (error) {
        return refused("Couldn't answer", error);
      }
    case "spade.enable":
      return enable(owner, spade, signal);
  }
}

/**
 * The message shows at once in the open conversation. When no answer came back Spade may have
 * it: it stays once Spade's copy arrives, and only a message Spade never stored is refused, so
 * its words go back to the composer.
 */
async function send(
  spade: NativeSpade,
  conversation: string,
  text: string,
  deps: { id(): string },
  post: () => Promise<string>,
): Promise<Outcome> {
  const follow = spade.follow(conversation);
  const key = `local-${deps.id()}`;
  follow?.apply({ kind: "sent", key, text, images: [], documents: [] });
  try {
    await post();
    spade.refresh();
    return { ok: true };
  } catch (error) {
    if (
      follow &&
      error instanceof SpadeRequestError &&
      error.unanswered &&
      (await follow.reached(key))
    ) {
      spade.refresh();
      return { ok: true };
    }
    follow?.apply({ kind: "refused", key });
    const bot = spade.botName(conversation);
    return refused(bot ? `Couldn't send to ${bot}` : "Couldn't send", error);
  }
}

/** `spade.enabled` is global and admin only: a device without admin is told so. */
async function enable(owner: ClientCore, spade: NativeSpade, signal: AbortSignal) {
  const reply = await owner
    .request(
      { type: "settings.set", key: "spade.enabled", value: true, layer: { kind: "global" } },
      { signal, timeoutMs: 10_000 },
    )
    .catch(() => undefined);
  spade.refresh();
  if (reply?.ok) return { ok: true } as const;
  return {
    ok: false,
    title: "Couldn't turn on Spade",
    message: "Only a device with admin access to this machine can change it.",
  } as const;
}

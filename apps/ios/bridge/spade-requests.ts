import type { ClientCore } from "@ace/client";
import {
  parseSpadeModels,
  spadeKeyLine,
  spadeModelRoles,
  spadeStart,
  spadeStopAnswered,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { segment, spadeText, type NativeSpade } from "./spade.ts";

/*
 * What the iPhone asks of Spade with an outcome it waits on: start a conversation, send, stop,
 * answer an approval, turn Spade on or off, read its models and set or remove an endpoint key.
 * Every answer is `{ok: true, ...}` or `{ok: false, title, message}` in the person's words.
 *
 * A key typed on the phone goes once to Spade through the daemon (ADR 0119, as the web sends
 * it), and Spade writes it to that machine's keychain. Nothing here keeps or logs it.
 */

const conversationId = z.string().min(1).max(256);
const text = z.string().trim().min(1).max(200_000);

export const NativeSpadeRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spade.start"), text }),
  z.object({ type: z.literal("spade.send"), conversationId, text }),
  z.object({ type: z.literal("spade.stop"), conversationId }),
  z.object({
    type: z.literal("spade.answer"),
    conversationId,
    callId: z.string().min(1).max(256),
    allowed: z.boolean(),
    always: z.boolean(),
  }),
  z.object({ type: z.literal("spade.enable"), on: z.boolean() }),
  z.object({ type: z.literal("spade.models") }),
  z.object({
    type: z.literal("spade.key"),
    endpoint: z.string().min(1).max(256),
    /** The key to save; null removes the one in the keychain. */
    key: z.string().trim().min(1).max(8192).nullable(),
  }),
]);
export type NativeSpadeRequest = z.infer<typeof NativeSpadeRequest>;

type Outcome = { ok: true } & Record<string, unknown>;
type Refusal = { ok: false; title: string; message: string; unknown?: true };

/** A conversation's path in Spade's API. */
const path = (id: string) => `/v1/conversations/${segment(id)}`;
const why = (error: unknown) => (error instanceof Error && error.message) || "Try again.";
const refused = (title: string, error: unknown): Refusal => ({
  ok: false,
  title,
  message: why(error),
});

export async function answerSpade(
  owner: ClientCore,
  spade: NativeSpade,
  request: NativeSpadeRequest,
  deps: { id(): string },
  signal: AbortSignal,
): Promise<Outcome | Refusal> {
  const ask = (method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown) =>
    spadeText(owner, deps.id, method, route, body, signal);
  switch (request.type) {
    case "spade.start":
      try {
        const link = {
          read: (route: string) => ask("GET", route),
          post: (route: string, body: unknown) => ask("POST", route, body),
          back: () => spade.reachable(),
        };
        // The phone sends words only.
        const started = await spadeStart(
          link,
          { text: request.text },
          { text: request.text, images: 0 },
        );
        spade.refresh();
        if (started.kind === "started") return { ok: true, id: started.id };
        // Spade may have it: the words stay out of the composer, so a retry can't start it twice.
        return {
          ok: false,
          unknown: true,
          title: "Couldn't tell whether Spade started the conversation",
          message: "If it did, it shows in Spade's conversations once this machine is back.",
        };
      } catch (error) {
        return refused("Couldn't start the conversation", error);
      }
    case "spade.send": {
      const post = () =>
        ask("POST", `${path(request.conversationId)}/messages`, {
          text: request.text,
        });
      try {
        const follow = spade.follow(request.conversationId);
        if (follow) await follow.send({ key: `local-${deps.id()}`, text: request.text }, post);
        else await post();
        spade.refresh();
        return { ok: true };
      } catch (error) {
        return refused("Couldn't send to Spade", error);
      }
    }
    case "spade.stop":
      try {
        await ask("POST", `${path(request.conversationId)}/stop`);
      } catch (error) {
        if (!spadeStopAnswered(error)) return refused("Couldn't stop Spade", error);
      }
      return { ok: true };
    case "spade.answer":
      try {
        await ask("POST", `${path(request.conversationId)}/approvals/${segment(request.callId)}`, {
          allowed: request.allowed,
          always: request.always,
        });
        return { ok: true };
      } catch (error) {
        return refused("Couldn't answer Spade", error);
      }
    case "spade.enable":
      return enable(owner, spade, request.on, signal);
    case "spade.models":
      return models(await ask("GET", "/v1/models").catch((error: unknown) => error));
    case "spade.key":
      try {
        const keyPath = `/v1/keys/${segment(request.endpoint)}`;
        if (request.key === null) await ask("DELETE", keyPath);
        else await ask("PUT", keyPath, { key: request.key });
        return { ok: true };
      } catch (error) {
        return refused(
          request.key === null ? "Couldn't remove the key" : "Couldn't save the key",
          error,
        );
      }
  }
}

/** `spade.enabled` is global and admin only: a device without admin is told so. */
async function enable(
  owner: ClientCore,
  spade: NativeSpade,
  on: boolean,
  signal: AbortSignal,
): Promise<Outcome | Refusal> {
  const title = on ? "Couldn't turn on Spade" : "Couldn't turn off Spade";
  const reply = await owner
    .request(
      { type: "settings.set", key: "spade.enabled", value: on, layer: { kind: "global" } },
      { signal, timeoutMs: 10_000 },
    )
    .catch(() => undefined);
  spade.refresh();
  if (reply?.ok) return { ok: true };
  return {
    ok: false,
    title,
    message: "Only a device with admin access to this machine can change it.",
  };
}

/** Settings › Spade's sections: each endpoint, its key line and its models with their roles. */
function models(body: unknown): Outcome | Refusal {
  const parsed = typeof body === "string" ? parseSpadeModels(body) : undefined;
  if (!parsed)
    return refused(
      "Couldn't read Spade's models",
      body instanceof Error ? body : new Error("Spade's model list didn't make sense."),
    );
  return {
    ok: true,
    endpoints: parsed.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      key: endpoint.needsKey ? spadeKeyLine(endpoint, parsed.keychain) : null,
      models: endpoint.models.map((model) => ({
        id: model.id,
        name: model.name,
        roles: spadeModelRoles(parsed.roles, endpoint.id, model.id) ?? null,
      })),
    })),
  };
}

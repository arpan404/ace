import type { ClientCore } from "@ace/client";
import { spadeExchange, type SpadeAnswer } from "@ace/client/spade-http";
import {
  parseSpadeAgent,
  spadeAgentNameMax,
  spadeAgentTaskMax,
  spadeAvatarColors,
  spadeKeyLine,
  spadeModelFacts,
  spadeStopAnswered,
  spadeUnanswered,
  spadeUnconfirmedBotNote,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";
import { z } from "zod";
import { readSpadeModels, segment, spadeText, type NativeSpade } from "./spade.ts";

/*
 * What the iPhone asks of Spade with an outcome it waits on: send to a bot, stop it, answer an
 * approval, make a bot, turn Spade on or off, read its models, set or remove an endpoint key,
 * and read a bot's face. Every answer is `{ok: true, ...}` or `{ok: false, title, message}` in
 * the person's words.
 *
 * A key typed on the phone goes once to Spade through the daemon (ADR 0119, as the web sends
 * it), and Spade writes it to that machine's keychain. Nothing here keeps or logs it.
 */

const conversationId = z.string().min(1).max(256);
const text = z.string().trim().min(1).max(200_000);

export const NativeSpadeRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spade.send"), conversationId, text }),
  z.object({ type: z.literal("spade.stop"), conversationId }),
  z.object({
    type: z.literal("spade.answer"),
    conversationId,
    callId: z.string().min(1).max(256),
    allowed: z.boolean(),
    always: z.boolean(),
  }),
  /** A new bot on this machine (ADR 0126): its one conversation is made with it. */
  z.object({
    type: z.literal("spade.create"),
    name: z.string().trim().min(1).max(spadeAgentNameMax),
    task: z.string().trim().max(spadeAgentTaskMax),
    model: z.string().min(3).max(512),
    color: z.enum(spadeAvatarColors),
  }),
  z.object({ type: z.literal("spade.enable"), on: z.boolean() }),
  z.object({ type: z.literal("spade.models") }),
  z.object({
    type: z.literal("spade.key"),
    endpoint: z.string().min(1).max(256),
    /** The key to save; null removes the one in the keychain. */
    key: z.string().trim().min(1).max(8192).nullable(),
  }),
  /** A bot's uploaded face, by its hash. */
  z.object({ type: z.literal("spade.image"), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
]);
export type NativeSpadeRequest = z.infer<typeof NativeSpadeRequest>;

type Outcome = { ok: true } & Record<string, unknown>;
type Refusal = { ok: false; title: string; message: string };
/** Spade may have it: the form keeps the words with `note`, and nothing is sent again. */
type Unknown = { ok: false; unknown: true; note: string };

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
): Promise<Outcome | Refusal | Unknown> {
  const ask = (method: "GET" | "POST" | "PUT" | "DELETE", route: string, body?: unknown) =>
    spadeText(owner, deps.id, method, route, body, signal);
  switch (request.type) {
    case "spade.send": {
      const post = () =>
        ask("POST", `${path(request.conversationId)}/messages`, { text: request.text });
      try {
        // The open conversation shows it at once; a lost answer stays if Spade's copy arrives.
        const follow = spade.follow(request.conversationId);
        if (follow)
          await follow.send({ kind: "sent", key: `local-${deps.id()}`, text: request.text }, post);
        else await post();
        spade.refresh();
        return { ok: true };
      } catch (error) {
        return refused("Couldn't send it", error);
      }
    }
    case "spade.stop":
      try {
        await ask("POST", `${path(request.conversationId)}/stop`);
      } catch (error) {
        if (!spadeStopAnswered(error)) return refused("Couldn't stop it", error);
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
        return refused("Couldn't answer it", error);
      }
    case "spade.create":
      return create(spade, request, ask);
    case "spade.enable":
      return enable(owner, spade, request.on, signal);
    case "spade.models":
      try {
        const models = readSpadeModels(await ask("GET", "/v1/models"));
        spade.models(models);
        return { ok: true, ...modelRows(models) };
      } catch (error) {
        return refused("Couldn't read Spade's models", error);
      }
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
    case "spade.image":
      return image(owner, request.sha256, deps, signal);
  }
}

/**
 * A new bot with a generated face. When the answer is lost Spade may have made it, and nothing
 * says which bot a lost request made (Spade keeps no key for it), so the form keeps the words
 * with a note and nothing is sent again; the roster shows the bot if it was made.
 */
async function create(
  spade: NativeSpade,
  request: Extract<NativeSpadeRequest, { type: "spade.create" }>,
  ask: (method: "POST", route: string, body: unknown) => Promise<string>,
): Promise<Outcome | Refusal | Unknown> {
  try {
    const body = await ask("POST", "/v1/agents", {
      name: request.name,
      task: request.task,
      model: request.model,
      avatar: { kind: "generated", color: request.color },
    });
    const agent = parseSpadeAgent(body);
    if (!agent) throw new Error("Spade made the bot but didn't say where it is.");
    return { ok: true, agentId: agent.id, conversationId: agent.conversation };
  } catch (error) {
    if (spadeUnanswered(error)) return { ok: false, unknown: true, note: spadeUnconfirmedBotNote };
    return refused("Couldn't make the bot", error);
  } finally {
    spade.refresh();
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

/**
 * Settings › Spade's sections (each endpoint, its key line and its models with their facts),
 * and the models a new bot can run on: those of endpoints that need no key or have one.
 */
function modelRows(models: SpadeModels) {
  return {
    endpoints: models.endpoints.map((endpoint) => ({
      id: endpoint.id,
      name: endpoint.name,
      key: endpoint.needsKey ? spadeKeyLine(endpoint, models.keychain) : null,
      models: endpoint.models.map((model) => ({
        id: model.id,
        name: model.name || model.id,
        facts: spadeModelFacts(model) || null,
      })),
    })),
    choices: models.endpoints
      .filter((endpoint) => !endpoint.needsKey || endpoint.keySet)
      .flatMap((endpoint) =>
        endpoint.models.map((model) => ({
          ref: `${endpoint.id}/${model.id}`,
          label: `${model.name || model.id} · ${endpoint.name}`,
        })),
      ),
  };
}

/** A bot's uploaded face, as base64 for Swift to draw. */
async function image(
  owner: ClientCore,
  sha256: string,
  deps: { id(): string },
  signal: AbortSignal,
): Promise<Outcome | Refusal> {
  const title = "Couldn't read the picture";
  let answer: SpadeAnswer;
  try {
    answer = await spadeExchange(
      owner,
      { method: "GET", path: `/v1/images/${sha256}` },
      { id: deps.id, signal },
    );
  } catch (error) {
    return refused(title, error);
  }
  if (answer.kind === "error") return refused(title, new Error(answer.message));
  if (answer.status !== 200 || answer.encoding !== "base64") return refused(title, undefined);
  return { ok: true, data: answer.body };
}

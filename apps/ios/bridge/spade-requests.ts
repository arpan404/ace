import type { ClientCore } from "@ace/client";
import { z } from "zod";
import { answerSpadeNewBot, spadeNewBotRequests } from "./spade-new-bot.ts";
import { answerSpadeSettings, spadeSettingsRequests } from "./spade-settings.ts";
import type { NativeSpade } from "./spade.ts";
import { spadeText } from "./spade-text.ts";
import {
  answerFromAreas,
  spadeRequestArea,
  type SpadeRequestArea,
  type SpadeRequestContext,
  type SpadeRequestSchema,
} from "./spade-requests-area.ts";
import { spadeConversationRequests } from "./spade-requests-conversation.ts";
import { spadeGroupRequests } from "./spade-requests-groups.ts";
import { spadeProfileRequests } from "./spade-requests-profile.ts";

/*
 * What the iPhone asks of Spade with an outcome it waits on, one area per module
 * (`spade-requests-area.ts`): a conversation, a group, a bot's profile, Settings › Spade and New
 * bot. Every answer is `{ok: true}` or `{ok: false, title, message}` in the person's words; a
 * card's also says which question (`at`) needs more. A new area is one module and one line in
 * `spadeRequestAreas`.
 */

export const spadeRequestAreas = [
  spadeConversationRequests,
  spadeGroupRequests,
  spadeProfileRequests,
  spadeRequestArea(spadeSettingsRequests, ({ owner, spade, deps, ask, signal }, request) =>
    answerSpadeSettings(owner, spade, request, deps, ask, signal),
  ),
  spadeRequestArea(spadeNewBotRequests, ({ spade, ask }, request) =>
    answerSpadeNewBot(spade, request, ask),
  ),
] as const;

/** Every area's request schemas, in table order, as one tuple. */
type SpadeAreaRequests<T> = T extends readonly [SpadeRequestArea<infer S, unknown>, ...infer Rest]
  ? [...S, ...SpadeAreaRequests<Rest>]
  : [];

// `flatMap` keeps every schema in table order but not the tuple's type, which this restates.
const schemas = spadeRequestAreas.flatMap(
  (area): readonly SpadeRequestSchema[] => area.requests,
) as SpadeAreaRequests<typeof spadeRequestAreas>;

export const NativeSpadeRequest = z.discriminatedUnion("type", schemas);
export type NativeSpadeRequest = z.infer<typeof NativeSpadeRequest>;

type Answer = NonNullable<Awaited<ReturnType<(typeof spadeRequestAreas)[number]["answer"]>>>;

/** What every area's answer may use, for requests from `owner`'s device. */
export function spadeRequestContext(
  owner: ClientCore,
  spade: NativeSpade,
  deps: SpadeRequestContext["deps"],
  signal: AbortSignal,
): SpadeRequestContext {
  const ask: SpadeRequestContext["ask"] = (method, route, body, timeoutMs) =>
    spadeText(owner, deps.id, method, route, body, signal, timeoutMs);
  return { owner, spade, deps, ask, signal };
}

export function answerSpade(
  owner: ClientCore,
  spade: NativeSpade,
  request: NativeSpadeRequest,
  deps: SpadeRequestContext["deps"],
  signal: AbortSignal,
): Promise<Answer> {
  return answerFromAreas<Answer>(
    spadeRequestAreas,
    spadeRequestContext(owner, spade, deps, signal),
    request,
  );
}

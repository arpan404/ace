import type { ClientCore } from "@ace/client";
import type { z } from "zod";
import type { ImageBudget } from "./image-budget.ts";
import type { ChunkReader } from "./thread-attachments.ts";
import { segment, type NativeSpade } from "./spade.ts";

/*
 * One area of what the iPhone asks of Spade (`spade-requests.ts`): its request schemas and the
 * answer to each. An area answers only the requests it lists, so the table of areas is the whole
 * dispatch.
 */

export type SpadeRefusal = { ok: false; title: string; message: string; at?: number };
export type SpadeOutcome = { ok: true } | SpadeRefusal;

export type SpadeAsk = (
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  route: string,
  body?: unknown,
  timeoutMs?: number,
) => Promise<string>;

/** What every area's answer may use. */
export interface SpadeRequestContext {
  owner: ClientCore;
  spade: NativeSpade;
  deps: { id(): string; now(): number; images: ImageBudget; chunks: ChunkReader };
  ask: SpadeAsk;
  signal: AbortSignal;
}

/** A request schema an area lists: an object told apart by its literal `type`. */
export type SpadeRequestSchema = z.ZodObject<{ type: z.ZodLiteral<string> } & z.ZodRawShape>;

export interface SpadeRequestArea<S extends readonly SpadeRequestSchema[], A> {
  readonly requests: S;
  /** The answer when the request is one of this area's, otherwise `undefined`. */
  answer(context: SpadeRequestContext, request: { type: string }): Promise<A> | undefined;
}

export function spadeRequestArea<const S extends readonly SpadeRequestSchema[], A>(
  requests: S,
  answer: (context: SpadeRequestContext, request: z.infer<S[number]>) => Promise<A>,
): SpadeRequestArea<S, A> {
  const types = new Set<string>(requests.map((each) => each.shape.type.value));
  // The request was parsed with the union of every area's schemas, so its `type` says which.
  const owns = (request: { type: string }): request is { type: string } & z.infer<S[number]> =>
    types.has(request.type);
  return {
    requests,
    answer: (context, request) => (owns(request) ? answer(context, request) : undefined),
  };
}

/**
 * The answer from the one area in `areas` that lists the request's `type`. The request was parsed
 * with the union of every area's schemas, so one does.
 */
export function answerFromAreas<A>(
  areas: readonly SpadeRequestArea<readonly SpadeRequestSchema[], A>[],
  context: SpadeRequestContext,
  request: { type: string },
): Promise<A> {
  for (const area of areas) {
    const answer = area.answer(context, request);
    if (answer) return answer;
  }
  throw new Error(`No Spade area answers ${request.type}`);
}

export const spadeConversationPath = (id: string) => `/v1/conversations/${segment(id)}`;

export const spadeRefused = (title: string, error: unknown): SpadeRefusal => ({
  ok: false,
  title,
  message: (error instanceof Error && error.message) || "Try again.",
});

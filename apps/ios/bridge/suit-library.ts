import type { ClientCore, RequestOptions } from "@ace/client";
import { SuitAssetPath, SuitId, type SuitResponse, type SuitSummary } from "@ace/protocol/suits";
import { phoneSuit, phoneSuitRow, stillTint, type PhoneSuit } from "@ace/suits/phone";
import { phoneColourRoles, type PhoneColours } from "@ace/themes";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * This machine's Suit library on the phone (ADR 0150, "On the iPhone"): the list as rows for the
 * Look grid, read on every ready connection and again on each `suitsChanged`; each `suitActive`
 * an agent's preview, keep or revert sends this device, in order; and, on request, one Suit
 * resolved for the phone (`@ace/suits/phone`) or one of its assets. Swift applies what this
 * answers and keeps the device's own setting (`appearance.suit`) and its undo.
 */

export type SuitOwner = Pick<ClientCore, "request" | "connectionState" | "onMessage">;

const quiet: RequestOptions = { timeoutMs: 15_000 };

/** The list as Swift draws it; each row says whether it can be picked and why not. */
const listPatch = (suits: readonly SuitSummary[]) => ({
  type: "suits.list",
  suits: suits.map(phoneSuitRow),
});

/** Follows the list and the agent's `suitActive` pushes; returns the stop. */
export function followSuits(owner: SuitOwner, pump: PatchSink): () => void {
  let stopped = false;
  let asked = 0;
  let actives = 0;
  const connection = owner.connectionState();
  const list = async () => {
    if (connection.getSnapshot() !== "ready" || stopped) return;
    const ask = ++asked;
    try {
      const reply = await owner.request({ type: "suitRequest", request: { op: "list" } }, quiet);
      // A later list (or a push) has the newer answer.
      if (stopped || ask !== asked || reply.response.op !== "list") return;
      const suits = reply.response.suits;
      pump.put("suits", () => listPatch(suits));
    } catch {
      // A machine without Suits (older, or not ready) keeps what the phone last drew.
    }
  };
  const stopConnection = connection.subscribe(() => void list());
  const stopMessages = owner.onMessage((message) => {
    if (message.type === "suitsChanged") {
      asked += 1;
      const suits = message.suits;
      pump.put("suits", () => listPatch(suits));
    } else if (message.type === "suitActive") {
      // Each its own key: a preview and the keep after it must both arrive, in order.
      const active = message.active;
      pump.put(`suits.active:${++actives}`, () => ({
        type: "suits.active",
        order: actives,
        active,
      }));
    }
  });
  void list();
  return () => {
    stopped = true;
    stopConnection();
    stopMessages();
  };
}

export const SuitReadRequest = z.object({ type: z.literal("suit.read"), id: SuitId });
export const SuitAssetRequest = z.object({
  type: z.literal("suit.asset"),
  id: SuitId,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  path: SuitAssetPath,
});

/** The daemon's refusal, in words Swift shows as the reason a Suit couldn't be read. */
export class SuitRefused extends Error {}

const refused = (response: SuitResponse): never => {
  throw new SuitRefused(
    response.op === "error" ? response.message : "The Suit library answered something else.",
  );
};

/** One Suit as the phone applies it, or why it can't show. */
export async function readPhoneSuit(
  owner: Pick<ClientCore, "request">,
  request: z.infer<typeof SuitReadRequest>,
  signal: AbortSignal,
): Promise<PhoneSuit> {
  const reply = await owner.request(
    { type: "suitRequest", request: { op: "read", id: request.id } },
    { ...quiet, signal },
  );
  return reply.response.op === "read" ? phoneSuit(reply.response.suit) : refused(reply.response);
}

/** One asset of one version of a Suit, as base64 with its type. */
export async function readSuitAsset(
  owner: Pick<ClientCore, "request">,
  request: z.infer<typeof SuitAssetRequest>,
  signal: AbortSignal,
): Promise<{ mimeType: string; data: string }> {
  const { id, contentHash, path } = request;
  const reply = await owner.request(
    { type: "suitRequest", request: { op: "asset", id, contentHash, path } },
    { ...quiet, signal },
  );
  return reply.response.op === "asset"
    ? { mimeType: reply.response.mimeType, data: reply.response.data }
    : refused(reply.response);
}

/** The phone's sample of a still as drawn: a grid of average colours, at most 32 × 32. */
export const SuitStillTintRequest = z.object({
  type: z.literal("suit.stillTint"),
  colours: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  cells: z
    .array(
      z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]),
    )
    .min(1)
    .max(1024),
});

/** The thinnest page over the still at which the Suit's words read (`stillTint`). */
export function solveStillTint(request: z.infer<typeof SuitStillTintRequest>): { tint: number } {
  const roles = Object.fromEntries(
    phoneColourRoles.map((role) => [role, request.colours[role] ?? "#000000"]),
  ) as PhoneColours;
  return { tint: stillTint(roles, request.cells) };
}

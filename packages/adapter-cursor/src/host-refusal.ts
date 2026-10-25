import { z } from "zod";

/** The host turned a request down before handing any of it to the Cursor SDK. */
export class HostRefusal extends Error {}

const RefusedReply = z.object({ data: z.object({ refused: z.literal(true) }) });

/** Whether a host reply error says the request never reached the SDK. */
export function refusedByHost(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  try {
    return RefusedReply.safeParse(JSON.parse(error.message)).success;
  } catch {
    return false;
  }
}

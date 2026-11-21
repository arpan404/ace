import type { ClientApi } from "@ace/client";
import { proveAgain } from "./window-prover.ts";

/** Older daemons carry this refusal as text in some replies. */
export function isStandingRefusal(message: unknown): boolean {
  return (
    message === "Confirm your identity to continue." ||
    message ===
      "This is yours to do: do it in the ace app signed in as you, or on a device you paired from it."
  );
}

/** A refused write can be sent again after the daemon acknowledges proof on its connection. */
export async function withStanding<T>(
  client: ClientApi,
  send: () => Promise<T>,
  refused: (result: T) => boolean,
): Promise<T> {
  const result = await send();
  return refused(result) && (await proveAgain(client)) ? send() : result;
}

import type { MarketPublishAction } from "@ace/protocol/marketplace";

/*
 * The one market request a person-only publish action makes (ADR 0190), as both the daemon that
 * sends it and the app that asks for the person's grant for it build it: one builder, so the
 * grant names exactly the request the daemon makes, its target and its payload. Pure.
 */

export interface PersonMarketCall {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  /** The JSON body, sent as `JSON.stringify(json)`; absent for a request with none. */
  json?: unknown;
}

const segment = encodeURIComponent;
const entryPath = (action: { type: string; name: string }) =>
  `/v1/me/entries/${segment(action.type)}/${segment(action.name)}`;
const versionPath = (action: { type: string; name: string; version: string }) =>
  `${entryPath(action)}/versions/${segment(action.version)}`;

/**
 * The market request of an action the market takes only from the person: withdrawals,
 * transfers and answering one, handle changes, deleting an entry, verification and a profile's
 * edits. Undefined for any other action.
 */
export function personMarketCall(action: MarketPublishAction): PersonMarketCall | undefined {
  switch (action.action) {
    case "createProfile":
      return { method: "POST", path: "/v1/me/profile", json: action.profile };
    case "editProfile":
      return { method: "PUT", path: "/v1/me/profile", json: action.profile };
    case "changeHandle":
      return { method: "PUT", path: "/v1/me/handle", json: { handle: action.handle } };
    case "withdraw":
      return {
        method: "POST",
        path:
          action.version === undefined
            ? `${entryPath(action)}/withdraw`
            : `${versionPath({ ...action, version: action.version })}/withdraw`,
        json: { reason: action.reason },
      };
    case "deleteEntry":
      return { method: "DELETE", path: entryPath(action) };
    case "transfer":
      return { method: "POST", path: `${entryPath(action)}/transfer`, json: { to: action.to } };
    case "transferAnswer":
      return {
        method: "POST",
        path: `/v1/me/transfers/${segment(action.id)}/${action.accept ? "accept" : "decline"}`,
      };
    case "applyVerification": {
      const { action: _action, ...claims } = action;
      return { method: "POST", path: "/v1/me/verification", json: claims };
    }
    case "checkVerification":
      return { method: "POST", path: "/v1/me/verification/check" };
    default:
      return undefined;
  }
}

/** The body a call sends, byte for byte. */
export const marketCallBody = (call: { json?: unknown }): string | undefined =>
  call.json === undefined ? undefined : JSON.stringify(call.json);

/**
 * What a person's market grant names (`action`, ADR 0190): the method, the path with its query
 * exactly as sent, and the SHA-256 of the exact body, so a grant for one recipient, handle,
 * reason or version does nothing for another.
 */
export async function marketIntent(input: {
  method: string;
  path: string;
  body: string | Uint8Array | undefined;
}): Promise<string> {
  const bytes =
    typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : (input.body ?? new Uint8Array());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const hash = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${input.method} ${input.path} ${hash}`;
}

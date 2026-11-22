import {
  parseSpadeEndpoint,
  parseSpadeSignInFlow,
  type SpadeEndpoint,
  type SpadeSignInFlow,
  type SpadeSignInMethod,
} from "@ace/ui-core/spade-chat";
import { segment, spadeHttp, type SpadeTarget } from "./spade-requests.ts";

/*
 * Spade's provider-account routes (ADR 0214): adding an account of a preset, ChatGPT sign-ins
 * and signing out. Renaming and removing an account are the endpoint routes' (`spade-api.ts`).
 */

function sure<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`Spade's ${what} didn't make sense.`);
  return value;
}

/** Another account of a preset: the preset fills in the rest, its key is set on its row. */
export async function addPresetAccount(
  target: SpadeTarget,
  preset: string,
  name: string,
): Promise<SpadeEndpoint> {
  const body = await spadeHttp(target, "POST", "/v1/endpoints", { body: { preset, name } });
  return sure(parseSpadeEndpoint(body), "new account");
}

/**
 * Starts a ChatGPT sign-in, only once the person has read what it means (`terms_read`).
 * `account` names a signed-out account to sign back in; absent, it adds or renews one.
 */
export async function startChatgptSignIn(
  target: SpadeTarget,
  method: SpadeSignInMethod,
  account?: string,
): Promise<SpadeSignInFlow> {
  const body = await spadeHttp(target, "POST", "/v1/accounts/chatgpt", {
    body: { method, terms_read: true, ...(account ? { account } : {}) },
  });
  return sure(parseSpadeSignInFlow(body), "sign-in");
}

export async function readChatgptSignIn(
  target: SpadeTarget,
  flow: string,
  signal?: AbortSignal,
): Promise<SpadeSignInFlow> {
  const body = await spadeHttp(target, "GET", `/v1/accounts/chatgpt/${segment(flow)}`, {
    signal,
  });
  return sure(parseSpadeSignInFlow(body), "sign-in");
}

export async function cancelChatgptSignIn(target: SpadeTarget, flow: string): Promise<void> {
  await spadeHttp(target, "DELETE", `/v1/accounts/chatgpt/${segment(flow)}`);
}

/** Its tokens leave the keychain; the account and the bots on it stay. */
export async function signOutAccount(target: SpadeTarget, id: string): Promise<SpadeEndpoint> {
  const body = await spadeHttp(target, "POST", `/v1/endpoints/${segment(id)}/sign-out`);
  return sure(parseSpadeEndpoint(body), "account");
}

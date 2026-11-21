import { SpadeRequestError } from "@ace/ui-core/spade-chat";

/*
 * Writes that carry a secret from the phone: an endpoint's key, the Brave Search key, and an
 * app's token. Spade's own words never reach the phone on these: a refusal could quote what it
 * was sent, and a key must never come back (ADR 0119). Each failure is said in fixed words,
 * chosen by what Spade's status means. Pure.
 */

export type SecretRefusal = { ok: false; title: string; message: string };

/** What was being done: keeping a secret or removing one, and what it is called. */
export type SecretWrite =
  | { kind: "keep"; title: string; thing: string; owner: string }
  | { kind: "remove"; title: string };

/**
 * The fixed words for a failed secret write. `thing` is "key" or "token"; `owner` names who
 * refused it ("Spade", or the app for a token).
 */
export function secretRefusal(write: SecretWrite, error: unknown): SecretRefusal {
  const status = error instanceof SpadeRequestError ? error.status : undefined;
  const say = (message: string): SecretRefusal => ({ ok: false, title: write.title, message });
  if (status === undefined)
    return say(
      write.kind === "keep"
        ? `Spade didn't answer, so the ${write.thing} may not have been kept. Pull to refresh before trying again.`
        : "Spade didn't answer. Pull to refresh to see whether the key is still kept.",
    );
  if (status === 503) return say("This machine has no keychain to keep keys in.");
  if (write.kind === "remove")
    return say(
      status === 404 ? "There was no key to remove." : "Spade couldn't remove the key. Try again.",
    );
  if (status === 404) return say("It's gone from Spade. Pull to refresh.");
  if (status === 400 || status === 401 || status === 403 || status === 422)
    return say(`${write.owner} didn't take that ${write.thing}. Check it and try again.`);
  return say(`Spade couldn't keep the ${write.thing}. Try again.`);
}

/** Keeping a key for an endpoint or for Brave Search. */
export const keepKey: SecretWrite = {
  kind: "keep",
  title: "Couldn't keep the key",
  thing: "key",
  owner: "Spade",
};
export const removeKey: SecretWrite = { kind: "remove", title: "Couldn't remove the key" };

/** Reconnecting `app` with a token pasted on the phone. */
export const keepToken = (app: string): SecretWrite => ({
  kind: "keep",
  title: `Couldn't reconnect ${app}`,
  thing: "token",
  owner: app,
});

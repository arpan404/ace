import { parseSpadeConnectStart, parseSpadeConnectors } from "@ace/ui-core/spade-chat";
import { segment } from "./spade.ts";

/*
 * Reconnect from Settings › Spade › Apps (docs/design/spade.md): an app whose sign-in ended signs
 * in again. A token app takes a token pasted on the phone. A device sign-in shows its code and
 * the page to enter it on, which the phone can open (the refreshed row carries both). A sign-in
 * in the browser comes back to Spade on its own machine, so the phone says plainly to finish
 * there.
 */

type Ask = (method: "GET" | "POST", route: string, body?: unknown) => Promise<string>;

/** The app's name as Spade lists it, for the words; its id when the list can't be read. */
export async function appName(ask: Ask, id: string): Promise<string> {
  const listed = await ask("GET", "/v1/connectors").then(parseSpadeConnectors, () => undefined);
  return listed?.connectors.find((each) => each.id === id)?.name || id;
}

/**
 * Asks Spade to sign `id` in again. Answers what to say beside the page: nothing when it
 * connected or a device code shows in its row, or where to finish a browser sign-in.
 */
export async function reconnectApp(
  ask: Ask,
  id: string,
  token: string | undefined,
  names: { app: string; machine: string },
): Promise<string | undefined> {
  const body = await ask(
    "POST",
    `/v1/connectors/${segment(id)}/connect`,
    token === undefined ? {} : { token },
  );
  const started = parseSpadeConnectStart(body);
  if (started?.kind !== "sign_in") return undefined;
  return `${names.app} signs in through a browser on ${names.machine}. Finish there, in Settings › Spade › Apps.`;
}

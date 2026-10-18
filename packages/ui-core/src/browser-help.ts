import type { InteractionRequest } from "@ace/protocol";
import { addressHost } from "./browser-address.ts";

type BrowserHelp = Extract<InteractionRequest, { kind: "browser_help" }>;

/**
 * What an agent asks the person to do in a browser tab, as the strip and notifications say it:
 * "Sign in to github.com in the Browser". `other` takes the agent's own words. Pure.
 */
export function browserHelpTitle(request: BrowserHelp): string {
  const site = addressHost(request.url ?? "") ?? request.title ?? "the page";
  switch (request.reason) {
    case "login":
      return `Sign in to ${site} in the Browser`;
    case "captcha":
      return `Complete the check on ${site} in the Browser`;
    case "two_factor":
      return `Enter the sign-in code for ${site} in the Browser`;
    case "dialog":
      return `Answer the dialog on ${site} in the Browser`;
    case "other":
      return request.message.trim() || `Help with ${site} in the Browser`;
  }
}

/** The agent's own words under the title, unless the title already is them. */
export function browserHelpDetail(request: BrowserHelp): string | undefined {
  const message = request.message.trim();
  return request.reason === "other" || !message ? undefined : message;
}

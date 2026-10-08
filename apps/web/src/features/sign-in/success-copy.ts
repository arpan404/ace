import { providerNames } from "@ace/ui-core";
import type { SignInTarget } from "./login-controller.ts";

/** Shared by browser, terminal and API-key sign-ins. */
export function signInSuccess(target: SignInTarget, accountName?: string): string {
  const name = target.name ?? providerNames[target.provider];
  if (target.service)
    return `${target.service} is ${target.action === "logout" ? "disconnected" : "connected"}`;
  if (target.action === "logout") return `Signed out of ${name}`;
  const account = target.newAccount ?? accountName;
  return `Signed in to ${name}${account ? ` · ${account}` : ""}`;
}

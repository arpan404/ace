import { providerNames } from "@ace/ui-core";
import type { SignInTarget } from "./login-controller.ts";
import { loginSuccessMessage } from "./login-copy.ts";

/** Shared by browser, terminal and API-key sign-ins. */
export function signInSuccess(target: SignInTarget, accountName?: string): string {
  return loginSuccessMessage({
    name: target.name ?? providerNames[target.provider],
    action: target.action,
    service: target.service,
    account: target.newAccount ?? accountName,
  });
}

import { providerNames } from "@ace/ui-core";
import type { LoginView, SignInTarget } from "./login-controller.ts";
import { toastTimeouts } from "@/components/ui/toast.tsx";
import { loginSuccessMessage } from "./login-copy.ts";

/**
 * What the daemon says the person still needs to know after a success, such as an environment
 * key that keeps the provider signed in. The toast stays longer so it can be read.
 */
export function signInSuccessDetail(
  view: LoginView,
): { description: string; timeout: number } | undefined {
  if (view.kind !== "progress" || view.progress.state !== "succeeded") return undefined;
  const message = view.progress.message;
  return message ? { description: message, timeout: toastTimeouts.action } : undefined;
}

/** Shared by browser, terminal and API-key sign-ins. */
export function signInSuccess(target: SignInTarget, accountName?: string): string {
  return loginSuccessMessage({
    name: target.name ?? providerNames[target.provider],
    action: target.action,
    service: target.service,
    account: target.newAccount ?? accountName,
  });
}

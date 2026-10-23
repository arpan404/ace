import type { AntigravitySignInMethod } from "@ace/protocol";

/** How an Antigravity account can sign in, in the words every client shows. Google comes first. */
export const antigravitySignInMethods: readonly {
  method: AntigravitySignInMethod;
  label: string;
  /** Needs a Google Cloud project and location. */
  cloud: boolean;
}[] = [
  { method: "google", label: "Google account", cloud: false },
  { method: "enterprise", label: "Gemini Enterprise", cloud: true },
  { method: "agent_platform", label: "Agent Platform", cloud: true },
];

/** The label for how an account signs in. */
export function antigravitySignInLabel(method: AntigravitySignInMethod): string {
  return antigravitySignInMethods.find((entry) => entry.method === method)?.label ?? method;
}

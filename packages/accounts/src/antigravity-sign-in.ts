import type { AntigravitySignIn, AntigravitySignInMethod } from "@ace/protocol";

/*
 * Antigravity's ACP server names its sign-in methods by id (`initialize` authMethods). ace offers
 * three of them by its own names; the key-based ones are left out, since the agent keeps a key
 * only in memory and ace would have to store it.
 */
const methodIds: Readonly<Record<AntigravitySignInMethod, string>> = {
  google: "oauth-personal",
  enterprise: "oauth-business",
  agent_platform: "agent-platform",
};

/** The agent's method id for how the person chose to sign in. */
export function antigravityMethodId(signIn: Pick<AntigravitySignIn, "method">): string {
  return methodIds[signIn.method];
}

/** How an account signs in, from the method id it last signed in with; undefined when unknown. */
export function antigravitySignInOf(
  methodId: string | undefined,
): AntigravitySignInMethod | undefined {
  if (methodId === "vertex-ai") return "agent_platform";
  for (const [method, id] of Object.entries(methodIds) as [AntigravitySignInMethod, string][])
    if (id === methodId) return method;
  return undefined;
}

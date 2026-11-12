import type { aceAccountClient } from "@ace/client/ace-account";
import { deferredPart } from "@/lib/deferred-part.ts";

type AceAccountClient = ReturnType<typeof aceAccountClient>;
type Options = Parameters<typeof aceAccountClient>[0];
type Load = () => Promise<{ aceAccountClient: typeof aceAccountClient }>;

/**
 * The account backend's client with its code, and the schemas that check the backend's replies,
 * loaded after the first paint (ADR 0056): on its first call, or once the browser is idle. The
 * account's state and restore stay eager (`session-store.ts`); only the HTTP calls wait. A failed
 * load fails that call, as an unreachable backend would, and the next call loads again.
 */
export function lazyAceAccountClient(
  options: Options,
  load: Load = () => import("@ace/client/ace-account"),
): AceAccountClient {
  const part = deferredPart(async () => (await load()).aceAccountClient(options));
  part.warm();
  const client = () => part.load();
  return {
    login: async (...args) => (await client()).login(...args),
    poll: async (...args) => (await client()).poll(...args),
    cancel: async (...args) => (await client()).cancel(...args),
    session: async (...args) => (await client()).session(...args),
    logout: async (...args) => (await client()).logout(...args),
    grant: async (...args) => (await client()).grant(...args),
    picture: async (...args) => (await client()).picture(...args),
    machines: async (...args) => (await client()).machines(...args),
    forgetMachine: async (...args) => (await client()).forgetMachine(...args),
  };
}

import { useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { useAceAccountStore } from "@/features/ace-account/index.ts";
import { useMachineAccountAccess } from "@/features/settings/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";

/*
 * The way on from "sign in again" (a person-only action, ADR 0190): a browser sign-in for this
 * window, after which this window's sockets prove the person's standing with it. A daemon that
 * isn't signed in is signed in with an enrollment ticket too. The caller retries what was refused
 * once it resolves.
 */

export interface FreshSignIn {
  /** This build has an ace account to sign in to. */
  available: boolean;
  /** The browser sign-in is under way. */
  signing: boolean;
  /** Why the last attempt didn't finish, in a sentence. */
  problem: string | undefined;
  /** Signs in again; resolves true once this computer holds the fresh sign-in. */
  start(): Promise<boolean>;
}

export function useFreshSignIn(): FreshSignIn {
  const store = useAceAccountStore();
  const access = useMachineAccountAccess(usePrimaryMachine());
  const [signing, setSigning] = useState(false);
  const [problem, setProblem] = useState<string>();
  const start = async () => {
    if (!store || signing) return false;
    setSigning(true);
    setProblem(undefined);
    try {
      const signed = await store.signInAgain((address) => openExternalWhenReady(address));
      const session = store.get().session;
      if (!signed || !session) {
        setProblem(store.get().error || "Sign-in didn't finish. Try again.");
        return false;
      }
      const status = await access?.status().catch(() => undefined);
      if (access && !status?.signedIn) await access.signIn(store.origin, session.token);
      const { proveAgain } = await import("@/boot/window-prover.ts");
      await proveAgain();
      return true;
    } catch (cause) {
      setProblem(
        cause instanceof Error ? cause.message : "This computer couldn't take the sign-in.",
      );
      return false;
    } finally {
      setSigning(false);
    }
  };
  return { available: store !== undefined, signing, problem, start };
}

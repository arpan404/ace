import { useState } from "react";
import { openExternalWhenReady } from "@/boot/open-external.ts";
import { useAceAccountStore } from "@/features/ace-account/index.ts";
import { useMachineAccountAccess } from "@/features/settings/index.ts";
import { usePrimaryMachine } from "@/lib/machines.ts";

/*
 * The way on from "sign in again" (ADR 0174 §2: installing needs a sign-in from the last ten
 * minutes): a fresh browser sign-in for this window, handed to this computer's daemon so its
 * next market request counts as recent. The caller retries what was refused once it resolves.
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
      await access?.signIn(store.origin, session.token);
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

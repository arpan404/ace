import { ClientError } from "@ace/client";
import { AceAccountError } from "@ace/client/ace-account";
import type { GrantProblem } from "./main-machine.ts";

/** The window is signed in to another ace account than the machine's: no grant is asked for. */
export class OtherAccountError extends ClientError {
  constructor() {
    super("auth", "This machine is on your other ace account.");
  }
}

/**
 * A grant source that remembers why it was refused: no ace session in this window (signed
 * out), a session on another account than the machine's, or the backend saying the session
 * ended (401). Any other failure (the network) is
 * retried by the connection and says nothing here.
 */
export function trackedGrant(grant: () => Promise<string>): {
  grant(): Promise<string>;
  problem(): GrantProblem | undefined;
} {
  let problem: GrantProblem | undefined;
  return {
    async grant() {
      try {
        const token = await grant();
        problem = undefined;
        return token;
      } catch (error) {
        if (error instanceof OtherAccountError) problem = "other_account";
        else if (error instanceof ClientError && error.code === "auth") problem = "signed_out";
        else if (error instanceof AceAccountError && error.status === 401)
          problem = "session_ended";
        else problem = undefined;
        throw error;
      }
    },
    problem: () => problem,
  };
}

/**
 * Grants for one account machine, given only while the window holds the ace account it was
 * chosen on. A choice that didn't record its account is pinned to the account of its first
 * grant, so a window that later signs in to another account stops asking for it either way.
 * `holder` is the account the window holds now, or undefined when signed out (the grant then
 * says so itself).
 */
export function accountPinnedGrant(
  chosenOn: string | undefined,
  holder: () => Promise<string | undefined>,
  grant: () => Promise<string>,
): () => Promise<string> {
  let owner = chosenOn;
  return async () => {
    const current = await holder();
    if (current !== undefined) {
      owner ??= current;
      if (current !== owner) throw new OtherAccountError();
    }
    return grant();
  };
}

import { ClientError } from "@ace/client";
import { AceAccountError } from "@ace/client/ace-account";
import type { GrantProblem } from "./main-machine.ts";

/**
 * A grant source that remembers why it was refused: no ace session in this window (signed
 * out), or the backend saying the session ended (401). Any other failure (the network) is
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
        if (error instanceof ClientError && error.code === "auth") problem = "signed_out";
        else if (error instanceof AceAccountError && error.status === 401)
          problem = "session_ended";
        else problem = undefined;
        throw error;
      }
    },
    problem: () => problem,
  };
}

import { hasGraphicalSession, noSessionMessage } from "../linux-session.ts";
import { ComputerError } from "./errors.ts";

/**
 * The environment for Linux computer helpers: the Wayland session read at use time, or a
 * refusal the model can act on when nobody is logged in to one.
 */
export function linuxComputerEnvironment(
  session: () => Promise<NodeJS.ProcessEnv>,
): () => Promise<NodeJS.ProcessEnv> {
  return async () => {
    const env = await session();
    if (!hasGraphicalSession(env))
      throw new ComputerError("no_graphical_session", noSessionMessage(env));
    return env;
  };
}

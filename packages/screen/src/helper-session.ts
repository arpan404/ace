import type { ScreenState } from "@ace/protocol";
import type { Helper } from "./helper.ts";

export type HelperPort = Pick<Helper, "capabilities" | "request" | "requestV2">;
/** Only helpers advertising background routing receive the additive session envelope. */
export function helperSession(helper: Helper, state: () => ScreenState): HelperPort {
  return {
    get capabilities() {
      return helper.capabilities;
    },
    set capabilities(value) {
      helper.capabilities = value;
    },
    request(command) {
      const current = state();
      const routed =
        helper.capabilities?.background === true
          ? {
              ...command,
              sessionId: current.sessionId,
              mode: current.mode,
              secureInputAllowed: current.secureInputAllowed,
            }
          : command;
      return helper.request(routed);
    },
    requestV2(command) {
      return helper.requestV2(command);
    },
  };
}

import { ScreenPermissions, type ScreenState } from "@ace/protocol";
import { HelperCommandError } from "./helper.ts";
import type { HelperHost } from "./helper-host.ts";
import { authorizeInput } from "./policy.ts";
import type { Session } from "./session.ts";

type ActionRuntime = {
  host: HelperHost;
  authorize(session: Session): void;
  emit(session: Session): void;
  fail(session: Session, error: Error): void;
  audit(state: ScreenState, action: string, outcome: string): void;
};
/** Per-session ordering plus a shared native execution slot. No agent command is buffered in
 * the native helper behind another app's action with a stale authority envelope. */
export function executeSessionAction<T>(
  runtime: ActionRuntime,
  session: Session,
  actor: "human" | "agent",
  owner: string,
  dispatch: (session: Session) => Promise<T>,
  actionName: string,
): Promise<T> {
  runtime.authorize(session);
  authorizeInput(session, actor, owner);
  session.controllerBinding?.authorize();
  if (session.queuedActions >= 16) throw new Error("Input queue limit");
  session.queuedActions++;
  const epoch = session.epoch;
  const auditState = structuredClone(session.state);
  const validate = () => {
    if (session.epoch !== epoch || session.state.lifecycle !== "live")
      throw new Error("Controller changed");
    runtime.authorize(session);
    authorizeInput(session, actor, owner);
    session.controllerBinding?.authorize();
  };
  const action = session.actionTail
    .then(async () => {
      await session.pointerCleanup;
      return runtime.host.execute(validate, async () => {
        const permissions = ScreenPermissions.parse(
          await session.helper.request({ op: "permissions" }),
        );
        session.state.permissions = permissions;
        runtime.emit(session);
        if (!permissions.screenRecording)
          runtime.fail(session, new Error("Screen Recording permission revoked"));
        if (!permissions.accessibility || !permissions.screenRecording)
          throw new HelperCommandError("permission_denied", "macOS permission denied");
        validate();
        if (
          actor === "agent" &&
          session.state.mode === "background" &&
          !session.helper.capabilities?.background
        )
          throw new HelperCommandError(
            "foreground_required",
            "Helper cannot guarantee background input",
          );
        try {
          const result = await dispatch(session);
          if (actor === "agent") runtime.audit(auditState, actionName, "completed");
          return result;
        } catch (error) {
          if (actor === "agent")
            runtime.audit(
              auditState,
              actionName,
              error instanceof Error && "code" in error && typeof error.code === "string"
                ? error.code
                : "failed",
            );
          throw error;
        }
      });
    })
    .catch(async (error: unknown) => {
      if (session.failureCleanup) await session.failureCleanup;
      throw error;
    })
    .finally(() => {
      session.queuedActions--;
    });
  session.actionTail = action.then(
    () => {},
    () => {},
  );
  return action;
}

import { actionPermissionFailure, captureRevokedMessage } from "./permission-model.ts";
import { type ScreenState } from "@ace/protocol";
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
  /** The person's input needs no controls (cowork, ADR 0143). */
  cowork?: boolean;
};
/** Per-session ordering; only foreground input and clipboard work share a host lane. */
export function executeSessionAction<T>(
  runtime: ActionRuntime,
  session: Session,
  actor: "human" | "agent",
  owner: string,
  dispatch: (session: Session, validate: () => void) => Promise<T>,
  actionName: string,
  access: "input" | "semantic",
): Promise<T> {
  runtime.authorize(session);
  authorizeInput(session, actor, owner, runtime.cowork);
  session.controllerBinding?.authorize();
  if (session.queuedActions >= 16) throw new Error("Input queue limit");
  session.queuedActions++;
  const epoch = session.epoch;
  const auditState = structuredClone(session.state);
  const validate = () => {
    if (session.epoch !== epoch || session.state.lifecycle !== "live")
      throw new Error("Controller changed");
    runtime.authorize(session);
    authorizeInput(session, actor, owner, runtime.cowork);
    session.controllerBinding?.authorize();
  };
  const action = session.actionTail
    .then(async () => {
      await session.pointerCleanup;
      const execute =
        session.state.mode === "foreground"
          ? runtime.host.executeShared.bind(runtime.host)
          : runtime.host.execute.bind(runtime.host);
      return execute(validate, async () => {
        const permissions = await session.helper.permissions();
        if (JSON.stringify(session.state.permissions) !== JSON.stringify(permissions)) {
          session.state.permissions = permissions;
          runtime.emit(session);
        }
        if (!permissions.screenRecording)
          runtime.fail(session, new Error(captureRevokedMessage(permissions)));
        const failure = actionPermissionFailure(permissions, access);
        if (failure) throw new HelperCommandError("permission_denied", failure);
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
          const result = await dispatch(session, validate);
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
      if (error instanceof HelperCommandError && error.code === "timeout")
        runtime.fail(session, error);
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

import { ScreenPermissions, type ScreenState } from "@ace/protocol";
import type { Helper } from "./helper.ts";
export type ControlledSession = {
  state: ScreenState;
  helper: Helper;
  epoch: number;
  owner: string | undefined;
  queuedActions: number;
  actionTail: Promise<void>;
};
/** Serialization and epoch checks also guard semantic actions and named keys. */
export async function runControl(
  session: ControlledSession,
  actor: "human" | "agent",
  owner: string,
  policy: { authorize: () => void; emit: () => void; fail: (error: Error) => void },
  run: (helper: Helper) => Promise<void>,
): Promise<void> {
  policy.authorize();
  if (session.state.target.kind === "display") throw new Error("Display capture is view-only");
  if (session.state.controller !== actor || session.owner !== owner)
    throw new Error("Controller ownership required");
  if (session.queuedActions >= 16) throw new Error("Input queue limit");
  session.queuedActions++;
  const epoch = session.epoch;
  const execute = session.actionTail
    .then(async () => {
      if (session.epoch !== epoch) throw new Error("Controller changed");
      const permissions = ScreenPermissions.parse(
        await session.helper.request({ op: "permissions" }),
      );
      session.state.permissions = permissions;
      policy.emit();
      if (!permissions.screenRecording)
        policy.fail(new Error("Screen Recording permission revoked"));
      if (!permissions.accessibility || !permissions.screenRecording)
        throw new Error("Screen input permission denied");
      policy.authorize();
      if (
        session.epoch !== epoch ||
        session.state.controller !== actor ||
        session.state.lifecycle !== "live"
      )
        throw new Error("Controller changed");
      await run(session.helper);
    })
    .finally(() => {
      session.queuedActions--;
    });
  session.actionTail = execute.catch(() => {});
  return execute;
}

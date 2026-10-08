import { HelperCommandError } from "./helper.ts";
import type { Session } from "./session.ts";
export type AppOperation = { op: "open.url"; url: string } | { op: "menu.press"; path: string[] };
function appTarget(session: Session) {
  if (session.helper.capabilities?.platform !== "macos")
    throw new HelperCommandError(
      "not_supported",
      "Native app operations need the macOS helper",
      "rejected-before-dispatch",
    );
  const target = session.state.target;
  if (target.kind === "display")
    throw new HelperCommandError(
      "not_supported",
      "Select an app session first",
      "rejected-before-dispatch",
    );
  return target;
}
export async function selectSessionWindow(
  session: Session,
  windowId: number,
  validate: () => void,
  beforeDispatch: () => void,
): Promise<void> {
  const target = appTarget(session);
  if (!session.helper.capabilities?.windowSelection)
    throw new HelperCommandError(
      "not_supported",
      "Helper cannot switch session windows",
      "rejected-before-dispatch",
    );
  await session.helper.request({ op: "window.select", windowId }, () => {
    validate();
    beforeDispatch();
    validate();
  });
  validate();
  session.epoch++;
  session.state.target = { kind: "window", bundleId: target.bundleId, windowId };
  session.modelCoordinates = undefined;
  session.latest = undefined;
  session.hub.clear();
  session.pixels.invalidateImage();
}
export function performAppOperation(
  session: Session,
  operation: AppOperation,
  validate: () => void,
  beforeDispatch: () => void,
) {
  const target = appTarget(session);
  return session.helper.request(
    operation.op === "open.url"
      ? { ...operation, bundleId: target.bundleId, allowlist: [target.bundleId] }
      : operation,
    () => {
      validate();
      beforeDispatch();
      validate();
    },
  );
}

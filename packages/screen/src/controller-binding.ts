import type { Session } from "./session.ts";
export function releaseControllerBinding(session: Session): Error | undefined {
  const binding = session.controllerBinding;
  session.controllerBinding = undefined;
  try {
    binding?.released();
  } catch (error) {
    return error instanceof Error ? error : new Error("Controller release failed");
  }
  return undefined;
}

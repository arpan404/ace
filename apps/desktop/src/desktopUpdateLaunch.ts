export const DESKTOP_UPDATE_ARG = "--ace-update";

export type DesktopSecondInstanceAction = "focus" | "run-update";

export function hasDesktopUpdateArg(argv: ReadonlyArray<string>, isPackaged: boolean): boolean {
  return isPackaged && argv.includes(DESKTOP_UPDATE_ARG);
}

export function resolveDesktopSecondInstanceAction(
  argv: ReadonlyArray<string>,
  isPackaged: boolean,
): DesktopSecondInstanceAction {
  return hasDesktopUpdateArg(argv, isPackaged) ? "run-update" : "focus";
}

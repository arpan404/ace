/** A page the popover opens in the app window (`DeepLink` in apps/desktop). */
export type TrayLink =
  | { kind: "thread"; threadId: string }
  | { kind: "settings"; page?: string }
  | { kind: "usage" };

/** The menu-bar popover's requests to the desktop app (`window.ace.tray`). */
export interface DesktopTray {
  /** Show the app window, on `link` when given, and close the popover. */
  open(link?: TrayLink): void;
  /** Size the popover to the page's height. */
  fit(height: number): void;
  /** Close the popover (Esc). */
  hide(): void;
  quit(completely: boolean): void;
}

/**
 * The desktop's popover bridge; undefined in a browser or a desktop build without it. Each call
 * is fire-and-forget: the main process refuses it from any page but the popover's.
 */
export function desktopTray(scope: object = globalThis): DesktopTray | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const tray: unknown = typeof ace === "object" && ace ? Reflect.get(ace, "tray") : undefined;
  if (typeof tray !== "object" || !tray) return undefined;
  const method = (name: string) => {
    const value: unknown = Reflect.get(tray, name);
    return typeof value === "function"
      ? (...args: unknown[]) =>
          void Promise.resolve()
            .then(() => Reflect.apply(value, tray, args))
            .catch(() => {})
      : undefined;
  };
  const open = method("open");
  const fit = method("fit");
  const quit = method("quit");
  const hide = method("hide");
  if (!open || !fit || !quit || !hide) return undefined;
  return {
    open: (link) => open(link ?? null),
    fit: (height) => fit(Math.round(height)),
    hide: () => hide(),
    quit: (completely) => quit(completely),
  };
}

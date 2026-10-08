/**
 * Open a web address in this device's own browser. The desktop app hands it to the system
 * through its bridge (`ace.shell.openExternal`, which only accepts http and https); a browser
 * opens a new tab without giving it a handle back to ace.
 */
export async function openExternal(url: string, scope: object = globalThis): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only web addresses open outside ace.");
  const open = systemOpener(scope);
  if (open) {
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Open an address that is still being fetched (a single-use sign-in link) in this device's own
 * browser. A browser blocks a tab opened after waiting, so the tab opens at once, blank and cut
 * off from ace, and goes to the address when it arrives; if fetching it fails the tab closes.
 */
export async function openExternalWhenReady(
  address: Promise<string>,
  scope: object = globalThis,
): Promise<void> {
  const open = systemOpener(scope);
  if (open) {
    await openExternal(await address, scope);
    return;
  }
  const tab = window.open("", "_blank");
  if (!tab) {
    // Keep the rejection handled; the blocked tab is what the person needs to hear about.
    address.catch(() => {});
    throw new Error("The browser blocked the new tab.");
  }
  tab.opener = null;
  try {
    const url = await address;
    if (!/^https?:\/\//i.test(url)) throw new Error("Only web addresses open outside ace.");
    tab.location.replace(url);
  } catch (error) {
    tab.close();
    throw error;
  }
}

/** The desktop bridge's `shell.openExternal`, when there is one. */
function systemOpener(scope: object): ((url: string) => Promise<unknown>) | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const shell =
    typeof ace === "object" && ace !== null && "shell" in ace ? (ace.shell as unknown) : undefined;
  const open =
    typeof shell === "object" && shell !== null && "openExternal" in shell
      ? shell.openExternal
      : undefined;
  if (typeof open !== "function") return undefined;
  return (url) => Promise.resolve(Reflect.apply(open, shell, [url]));
}

/**
 * Whether a page opens in the system browser without a click of its own (the desktop app); a
 * browser tab would block it as a pop-up.
 */
export function opensWithoutClick(scope: object = globalThis): boolean {
  return systemOpener(scope) !== undefined;
}

/** The desktop app's "show in Finder" for a path on this computer; undefined in a browser. */
export function revealer(
  scope: object = globalThis,
): ((path: string) => Promise<void>) | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  const shell =
    typeof ace === "object" && ace !== null && "shell" in ace ? (ace.shell as unknown) : undefined;
  const reveal =
    typeof shell === "object" && shell !== null && "reveal" in shell ? shell.reveal : undefined;
  if (typeof reveal !== "function") return undefined;
  return async (path) => {
    await Promise.resolve(Reflect.apply(reveal, shell, [path]));
  };
}

/**
 * Open a web address in this device's own browser. The desktop app hands it to the system
 * through its bridge (`ace.shell.openExternal`, which only accepts http and https); a browser
 * opens a new tab without giving it a handle back to ace.
 */
export async function openExternal(url: string, scope: object = globalThis): Promise<void> {
  if (!/^https?:\/\//i.test(url)) throw new Error("Only web addresses open outside ace.");
  const ace: unknown = Reflect.get(scope, "ace");
  const shell =
    typeof ace === "object" && ace !== null && "shell" in ace ? (ace.shell as unknown) : undefined;
  const open =
    typeof shell === "object" && shell !== null && "openExternal" in shell
      ? shell.openExternal
      : undefined;
  if (typeof open === "function") {
    await Promise.resolve(Reflect.apply(open, shell, [url]));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

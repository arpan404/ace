import { DaemonTarget } from "./connection-settings.ts";

/**
 * In the Electron app the preload bridge (`window.ace`) hands over the daemon address and
 * token, never through the URL (ADR 0045). In a browser there is no bridge and this returns
 * undefined. The desktop's fake mode answers `{ mode: "fake" }`, which does not parse.
 */
export async function desktopTarget(scope: object = globalThis): Promise<DaemonTarget | undefined> {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("daemon" in ace)) return undefined;
  const daemon: unknown = ace.daemon;
  if (typeof daemon !== "object" || daemon === null || !("connection" in daemon)) return undefined;
  if (typeof daemon.connection !== "function") return undefined;
  try {
    const parsed = DaemonTarget.safeParse(await daemon.connection());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

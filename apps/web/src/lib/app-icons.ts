import { useQuery } from "@tanstack/react-query";

/*
 * Any app's own icon by its bundle id, as this computer's OS draws it (a PNG data URL): the
 * desktop app reads it from the app itself, so nothing is bundled. Computer-use steps show the
 * app the agent used with it; a browser, which can't ask, shows the app's letter instead.
 */

const pngDataUrl = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

/** The desktop bridge's reader, or undefined in a browser. */
export function appIconReader(
  scope: object = globalThis,
): ((bundleId: string) => Promise<string | null>) | undefined {
  const ace: unknown = Reflect.get(scope, "ace");
  if (typeof ace !== "object" || ace === null || !("shell" in ace)) return undefined;
  const shell: unknown = ace.shell;
  if (typeof shell !== "object" || shell === null || !("appIcon" in shell)) return undefined;
  const read: unknown = shell.appIcon;
  if (typeof read !== "function") return undefined;
  return async (bundleId) => {
    const icon: unknown = await Promise.resolve(Reflect.apply(read, shell, [bundleId]));
    return typeof icon === "string" && pngDataUrl.test(icon) ? icon : null;
  };
}

/** The app's icon; undefined while read or in a browser, null when the OS has none. */
export function useAppIcon(bundleId: string | undefined): string | null | undefined {
  const read = appIconReader();
  return useQuery({
    queryKey: ["app-icon", bundleId],
    queryFn: () => (read && bundleId ? read(bundleId) : null),
    enabled: read !== undefined && bundleId !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  }).data;
}

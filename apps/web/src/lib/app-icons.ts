import { useQuery } from "@tanstack/react-query";
import { appIdentityReader } from "../boot/app-identity.ts";

/*
 * Any app's own icon by its bundle id, as this computer's OS draws it (a PNG data URL): the
 * desktop app reads it from the app itself, so nothing is bundled. Computer-use steps show the
 * app the agent used with it; a browser without OS metadata shows a neutral app glyph.
 */

/** The shared bounded desktop metadata lookup also supplies computer-use icons. */
export function appIconReader(
  scope: object = globalThis,
): ((bundleId: string) => Promise<string | null>) | undefined {
  const read = appIdentityReader(scope);
  return read ? async (bundleId) => (await read(bundleId))?.icon ?? null : undefined;
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

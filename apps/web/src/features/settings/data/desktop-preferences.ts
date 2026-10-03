import { useMemo, useSyncExternalStore } from "react";
import {
  desktopPreferences,
  type DesktopPreferences,
  type DesktopPreferencesPatch,
} from "@/boot/desktop-settings.ts";

const noSubscription = () => () => {};
const nothing = () => undefined;

/**
 * The desktop app's own preferences (login item, this computer's notifications), live.
 * `available` is false in a browser; `value` is undefined until the desktop answers.
 */
export function useDesktopPreferences(): {
  available: boolean;
  value: DesktopPreferences | undefined;
  update(patch: DesktopPreferencesPatch): Promise<void>;
} {
  const store = useMemo(() => desktopPreferences(), []);
  const value = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.get ?? nothing,
    store?.get ?? nothing,
  );
  return useMemo(
    () => ({
      available: store !== undefined,
      value,
      update: (patch: DesktopPreferencesPatch) => store?.update(patch) ?? Promise.resolve(),
    }),
    [store, value],
  );
}

import { useSyncExternalStore } from "react";

import {
  readStoredSidebarTranslucent,
  setStoredSidebarTranslucent,
  subscribeSidebarTranslucent,
} from "../appearancePrefs";

function getServerSnapshot(): boolean {
  return false;
}

export function useSidebarTranslucent() {
  const translucent = useSyncExternalStore(
    subscribeSidebarTranslucent,
    readStoredSidebarTranslucent,
    getServerSnapshot,
  );
  return { translucent, setTranslucent: setStoredSidebarTranslucent } as const;
}

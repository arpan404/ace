import { useEffect } from "react";
import { useSidebarAside } from "@/lib/layout.tsx";

/**
 * While `wanted` (a PR page on its Code tab), the sidebar steps aside so the diff has the
 * room; leaving Code brings it back as it was. Showing the sidebar by hand keeps it shown.
 */
export function useCodeRoom(wanted: boolean): void {
  const setSidebarAside = useSidebarAside();
  useEffect(() => {
    if (!wanted) return;
    setSidebarAside(true);
    return () => setSidebarAside(false);
  }, [wanted, setSidebarAside]);
}

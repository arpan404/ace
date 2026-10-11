import { lazy, Suspense } from "react";
import { useLayout } from "@/lib/layout.tsx";
const Sheet = lazy(() =>
  import("./shortcut-sheet.tsx").then((module) => ({ default: module.ShortcutSheet })),
);
export function ShortcutHost() {
  const layout = useLayout();
  return layout.shortcutsOpen ? (
    <Suspense fallback={null}>
      <Sheet />
    </Suspense>
  ) : null;
}

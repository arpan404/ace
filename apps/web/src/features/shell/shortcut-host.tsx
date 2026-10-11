import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { useLayout } from "@/lib/layout.tsx";
const Sheet = deferredComponent(() =>
  import("./shortcut-sheet.tsx").then((module) => module.ShortcutSheet),
);
export function ShortcutHost() {
  const layout = useLayout();
  return layout.shortcutsOpen ? (
    <Suspense fallback={null}>
      <Sheet.Component />
    </Suspense>
  ) : null;
}

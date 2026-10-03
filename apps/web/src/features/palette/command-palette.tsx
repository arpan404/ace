import { lazy, Suspense, useCallback, useEffect } from "react";
import { CommandDialog } from "@/components/ui/command.tsx";
import { useLayout } from "@/lib/layout.tsx";

// The palette's commands reach into most views; they load on first use (or when the
// browser is idle), keeping them out of the first paint's bundle.
const load = () => import("./palette-body.tsx");
const PaletteBody = lazy(load);

/** ⌘K. Focus moves to the search field on open and returns to the opener on close. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useLayout();
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  useEffect(() => {
    const idle = globalThis.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 2_000));
    idle(() => void load());
  }, []);
  return (
    <CommandDialog open={paletteOpen} onOpenChange={setPaletteOpen}>
      {paletteOpen && (
        <Suspense fallback={null}>
          <PaletteBody close={close} />
        </Suspense>
      )}
    </CommandDialog>
  );
}

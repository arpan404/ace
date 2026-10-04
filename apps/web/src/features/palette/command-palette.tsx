import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { whenIdle } from "@/lib/idle.ts";
import { useLayout } from "@/lib/layout.tsx";

// The palette's sheet (Base UI's Autocomplete) and its commands, which reach into most views,
// load on first use or when the browser is idle, keeping them out of the first paint's bundle.
const load = () => import("./palette-dialog.tsx");
const PaletteDialog = lazy(load);

/** ⌘K. Focus moves to the search field on open and returns to the opener on close. */
export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useLayout();
  const close = useCallback(() => setPaletteOpen(false), [setPaletteOpen]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    const cancel = whenIdle(
      () =>
        void load().then(() => {
          if (live) setLoaded(true);
        }),
    );
    return () => {
      live = false;
      cancel();
    };
  }, []);
  // Mounted once loaded (or asked for), so its exit animation always has a dialog to play on.
  if (!loaded && !paletteOpen) return null;
  return (
    <Suspense fallback={null}>
      <PaletteDialog open={paletteOpen} onOpenChange={setPaletteOpen} close={close} />
    </Suspense>
  );
}

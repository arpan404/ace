import { createContext, useContext, type ReactNode } from "react";
import { environmentRow, environmentSurface } from "./composer-styles.ts";

/** The same controls stay mounted below the editor through empty and expanded layouts. */
export const ComposerSettings = createContext<ReactNode>(null);

export function ComposerSettingsControls() {
  const settings = useContext(ComposerSettings);
  return (
    <div className="ml-auto flex min-w-0 max-w-full items-center gap-0.5 [--composer-control:28px]">
      {settings}
    </div>
  );
}

/** Composers without branch/machine context still expose their settings on an attached strip. */
export function ComposerSettingsStrip() {
  const settings = useContext(ComposerSettings);
  if (settings == null) return null;
  return (
    <section aria-label="Composer settings" className={environmentSurface}>
      <div className={environmentRow}>
        <ComposerSettingsControls />
      </div>
    </section>
  );
}

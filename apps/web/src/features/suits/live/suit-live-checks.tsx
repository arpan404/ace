import { useEffect, useRef } from "react";
import { desktopWindowCapture } from "@/boot/desktop.ts";
import { useTheme } from "@/theme/theme-provider.tsx";
import { useSuitLibrary } from "@/theme/suits/suit-library.tsx";
import { runLiveCheck } from "./run-live-check.ts";

/** How long a check waits for the asked Suit to be on screen before giving up silently. */
const showWaitMs = 6000;
/** A scene's first frames, and fonts, settle after the Suit applies. */
const settleMs = 400;

const later = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/**
 * Answers the daemon's `suitCheck` (ADR 0150, "Shown perfectly"): once the asked Suit is on
 * this page, runs the live check and sends the report with a capture of the window where the
 * desktop app can take one. A page that never shows that Suit (Suits off this session, a
 * failing Suit) doesn't answer, and the daemon falls back to the static checks. Renders nothing.
 */
export function SuitLiveChecks() {
  const { transport } = useSuitLibrary();
  const { suit, resolved } = useTheme();
  const latest = useRef({ suit: suit?.summary.id, scheme: resolved.scheme });
  useEffect(() => {
    latest.current = { suit: suit?.summary.id, scheme: resolved.scheme };
  });

  useEffect(() => {
    if (!transport) return;
    let stopped = false;
    const shown = async (id: string) => {
      for (let waited = 0; waited < showWaitMs; waited += 100) {
        if (stopped) return false;
        if (latest.current.suit === id) return true;
        await later(100);
      }
      return latest.current.suit === id;
    };
    const stop = transport.watchChecks((check) => {
      void (async () => {
        if (!(await shown(check.suitId))) return;
        await Promise.race([document.fonts.ready, later(1000)]);
        await later(settleMs);
        if (stopped || latest.current.suit !== check.suitId) return;
        const report = await runLiveCheck({
          check,
          document,
          scheme: latest.current.scheme,
          capture: desktopWindowCapture(),
        });
        if (!stopped) transport.report(report);
      })().catch((error: unknown) => console.warn("[suits] The live check failed", error));
    });
    return () => {
      stopped = true;
      stop();
    };
  }, [transport]);
  return null;
}

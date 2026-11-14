import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { SuitDetail, type SuitId, type SuitSummary } from "@ace/protocol/suits";
import { bootAppearanceKey } from "../appearance.ts";
import { appliedSuit } from "./applied-suit.ts";

/** What the Suit library has told this page so far (`SuitLibraryProvider` reports it). */
export interface SuitReport {
  summaries: readonly SuitSummary[] | undefined;
  /** The picked Suit's detail, once read. */
  detail: SuitDetail | undefined;
}

const BootSuit = z.object({ suit: SuitDetail });

/** The Suit the boot cache applied last launch, read once. */
function cachedSuit(storage: KeyValueStorage | undefined): SuitDetail | undefined {
  return readJson(storage, bootAppearanceKey, BootSuit.optional(), undefined)?.suit;
}

/**
 * The Suit that applies on this page, from the setting, the session's escape hatch, the boot
 * cache and the library's reports.
 */
export function useAppliedSuit(
  storage: KeyValueStorage | undefined,
  setting: SuitId | null,
  off: boolean,
) {
  const [cached] = useState(() => cachedSuit(storage));
  const [report, setReport] = useState<SuitReport>({ summaries: undefined, detail: undefined });
  const applied = useMemo(
    () =>
      appliedSuit({
        setting,
        off,
        summaries: report.summaries,
        detail: report.detail,
        cached,
      }),
    [setting, off, report, cached],
  );
  const reportSuits = useCallback((next: SuitReport) => setReport(next), []);
  return { applied, reportSuits };
}

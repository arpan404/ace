import { useCallback, useMemo, useState } from "react";
import { z } from "zod";
import { readJson, type KeyValueStorage } from "@ace/ui-core";
import { SuitDetail, type SuitId, type SuitSummary } from "@ace/protocol/suits";
import { bootAppearanceKey } from "../appearance.ts";
import { appliedSuit, sameVersion, wantedSuit } from "./applied-suit.ts";

/** What the Suit library has told this page so far (`SuitLibraryProvider` reports it). */
export interface SuitReport {
  summaries: readonly SuitSummary[] | undefined;
  /** The wanted Suit's detail, once read. */
  detail: SuitDetail | undefined;
  /** An agent's preview on top of the device setting; undefined when none runs. */
  preview: SuitId | null | undefined;
  /** A Suit being tried on (the Marketplace's Try it); it wins until the trial ends. */
  trial?: SuitDetail | undefined;
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
  const [cached, setCached] = useState(() => cachedSuit(storage));
  const [report, setReport] = useState<SuitReport>({
    summaries: undefined,
    detail: undefined,
    preview: undefined,
  });
  const applied = useMemo(
    () =>
      // A Suit tried on shows as it is, the session's escape hatch aside.
      (!off && report.trial) ||
      appliedSuit({
        setting: wantedSuit(setting, report.preview),
        off,
        summaries: report.summaries,
        detail: report.detail,
        cached,
      }),
    [setting, off, report, cached],
  );
  const reportSuits = useCallback((next: SuitReport) => setReport(next), []);
  /** Read the boot cache again: another window of the app applied a Suit and recorded it. */
  const recache = useCallback(
    () =>
      setCached((current) => {
        const next = cachedSuit(storage);
        // The same Suit read again keeps its object, so nothing downstream redraws or rewrites.
        return current && next && sameVersion(current.summary, next.summary) ? current : next;
      }),
    [storage],
  );
  return {
    applied,
    preview: report.preview,
    trying: report.trial !== undefined,
    reportSuits,
    recache,
  };
}

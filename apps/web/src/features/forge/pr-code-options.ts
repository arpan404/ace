import { useCallback, useState } from "react";
import { z } from "zod";
import { readJson, writeJson } from "@ace/ui-core";
import { useDiffPrefs, type DiffPrefs } from "@/features/panels/index.ts";
import { useLayout } from "@/lib/layout.tsx";

/** The layout a diff is drawn in, once Auto and the room are settled. */
export type DiffMode = "unified" | "split";

/**
 * How the Code tab draws: the choices every diff viewer shares (layout, wrapping, folds, visible
 * whitespace, the files tree), kept with the Changes panel's, plus what only a pull request can
 * do, kept on this device for every PR.
 */
export interface CodeOptions extends DiffPrefs {
  /** Changes that only touch whitespace read as unchanged lines. */
  hideWhitespace: boolean;
}

const key = "ace.pr.codeOptions";
const Stored = z.object({ hideWhitespace: z.boolean().catch(false) });
type PrOnly = z.infer<typeof Stored>;

/** The Code tab's options as this device last left them, and a setter that keeps each change. */
export function useCodeOptions(): [CodeOptions, (change: Partial<CodeOptions>) => void] {
  const { storage } = useLayout();
  const [shared, setShared] = useDiffPrefs();
  const [own, setOwn] = useState<PrOnly>(() =>
    readJson(storage, key, Stored, { hideWhitespace: false }),
  );
  const change = useCallback(
    ({ hideWhitespace, ...rest }: Partial<CodeOptions>) => {
      if (hideWhitespace !== undefined) {
        const next = { hideWhitespace };
        writeJson(storage, key, next);
        setOwn(next);
      }
      if (Object.keys(rest).length) setShared(rest);
    },
    [storage, setShared],
  );
  return [{ ...shared, ...own }, change];
}

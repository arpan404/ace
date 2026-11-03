import { useCallback, useState } from "react";
import { z } from "zod";
import { readJson, writeJson } from "@ace/ui-core";
import { useLayout } from "@/lib/layout.tsx";

export type DiffMode = "unified" | "split";

/** What the person chose about how the Code tab draws, kept on this device for every PR. */
export interface CodeOptions {
  mode: DiffMode;
  wrap: boolean;
  tree: boolean;
  /** Changes that only touch whitespace read as unchanged lines. */
  hideWhitespace: boolean;
}

export const defaultCodeOptions: CodeOptions = {
  mode: "unified",
  wrap: false,
  tree: true,
  hideWhitespace: false,
};

const key = "ace.pr.codeOptions";
// Each choice is read on its own, so one bad or missing value keeps the others.
const Stored = z.object({
  mode: z.enum(["unified", "split"]).catch(defaultCodeOptions.mode),
  wrap: z.boolean().catch(defaultCodeOptions.wrap),
  tree: z.boolean().catch(defaultCodeOptions.tree),
  hideWhitespace: z.boolean().catch(defaultCodeOptions.hideWhitespace),
});

/** The Code tab's options as this device last left them, and a setter that keeps each change. */
export function useCodeOptions(): [CodeOptions, (change: Partial<CodeOptions>) => void] {
  const { storage } = useLayout();
  const [options, setOptions] = useState(() =>
    readJson(storage, key, Stored, defaultCodeOptions),
  );
  const change = useCallback(
    (next: Partial<CodeOptions>) =>
      setOptions((previous) => {
        const merged = { ...previous, ...next };
        writeJson(storage, key, merged);
        return merged;
      }),
    [storage],
  );
  return [options, change];
}

import { createContext, useContext, useEffect, useMemo } from "react";
import type { EditorBuffers } from "@/features/editor-workbench/index.ts";
import { defaultIndent, useEditorPreferences } from "@/lib/editor-preferences.ts";
import { createAutoSave, type AutoSave } from "./auto-save.ts";
import type { SaveProblem } from "./editor-actions.ts";
import { setDefaultIndent } from "./editor-registry.ts";

/*
 * The editor panel's side of Settings › Editor: its auto save, configured from the device's
 * preferences as they change, and the indentation new files fall back to. Each editor reaches
 * the panel's auto save through the context.
 */

export const AutoSaveContext = createContext<AutoSave | undefined>(undefined);

/** The auto save a group's editor reports its edits and focus to. */
export function useAutoSaveContext(): AutoSave | undefined {
  return useContext(AutoSaveContext);
}

export function usePanelAutoSave(options: {
  buffers: EditorBuffers;
  online: boolean;
  /** A stable setter: what the status line says about a failed save. */
  problem(problem: SaveProblem): void;
}): AutoSave {
  const [preferences] = useEditorPreferences();
  const { buffers, online, problem } = options;
  const autoSave = useMemo(
    () =>
      createAutoSave({
        schedule: (run, ms) => {
          const timer = setTimeout(run, ms);
          return () => clearTimeout(timer);
        },
        file: (path) => buffers.buffer(path),
        failed: (path, message) => problem({ path, message }),
      }),
    [buffers, problem],
  );
  useEffect(() => () => autoSave.dispose(), [autoSave]);
  useEffect(() => autoSave.setOnline(online), [autoSave, online]);
  const { autoSave: mode, autoSaveDelay: delay } = preferences;
  useEffect(() => autoSave.configure({ mode, delay }), [autoSave, mode, delay]);
  const { tabs, size } = defaultIndent(preferences);
  useEffect(() => setDefaultIndent({ tabs, size }), [tabs, size]);
  return autoSave;
}

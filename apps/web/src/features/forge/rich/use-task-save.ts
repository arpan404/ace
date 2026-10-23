import { useLayoutEffect, useMemo, useRef } from "react";

type Save = (next: string) => Promise<boolean>;

/**
 * A task-box save for `ForgeProse` that keeps its identity while the text it saves stays the
 * same version (`version`), always calling the newest `save`. A new closure on every render would
 * redraw the whole body on every parent render or poll.
 */
export function useTaskSave(save: Save | undefined, version: string): Save | undefined {
  const latest = useRef(save);
  useLayoutEffect(() => {
    latest.current = save;
  });
  const enabled = save !== undefined;
  return useMemo(
    () =>
      enabled ? (next: string) => latest.current?.(next) ?? Promise.resolve(false) : undefined,
    // `version` renews it when the text changes, so a stale save never outlives its text.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [enabled, version],
  );
}

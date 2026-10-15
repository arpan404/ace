import { useCallback, useEffect, useEffectEvent, useState } from "react";

/** Keep one submit intent while reads finish; the editable draft remains its durable owner. */
export function usePreparedSubmit(options: {
  waiting: string | undefined;
  problem: string | undefined;
  selection: string;
  submit(): void;
}) {
  const [intent, setIntent] = useState<{ selection: string }>();
  const [error, setError] = useState<string>();
  const cancel = useCallback(() => setIntent(undefined), []);
  const pending = intent !== undefined && intent.selection === options.selection;
  const settled =
    !!intent && (intent.selection !== options.selection || !!options.problem || !options.waiting);
  const reconcile = useEffectEvent(() => {
    if (!intent) return;
    if (intent.selection !== options.selection || options.problem) {
      setIntent(undefined);
    } else if (!options.waiting) {
      setIntent(undefined);
      options.submit();
    }
  });
  useEffect(() => {
    if (!settled) return;
    let live = true;
    // Let the editor commit any concurrent edit before acting on the completed reads.
    queueMicrotask(() => {
      if (live) reconcile();
    });
    return () => {
      live = false;
    };
  }, [settled]);
  useEffect(() => {
    if (!intent) return;
    const timer = setTimeout(() => {
      setIntent(undefined);
      setError("Preparation is taking too long. Your message is still here. Try sending again.");
    }, 30_000);
    return () => clearTimeout(timer);
  }, [intent]);
  return {
    pending,
    error,
    cancel,
    request() {
      setError(undefined);
      setIntent((current) => current ?? { selection: options.selection });
    },
  };
}

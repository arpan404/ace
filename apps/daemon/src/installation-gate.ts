/**
 * Holds default CLI catalog discovery until the first provider check has reported each CLI's
 * installed version. A discovery that starts while the version is unknown is cancelled and run
 * again as soon as the version arrives, so every boot paid for each provider's discovery
 * session twice. A check that is slow or fails holds discovery for at most `waitMs`.
 */
export function installationGate(
  checked: Promise<unknown> | undefined,
  waitMs: number,
  delay: (run: () => void, milliseconds: number) => () => void,
): () => Promise<void> {
  if (!checked) return () => Promise.resolve();
  let gate: Promise<void> | undefined;
  return () =>
    (gate ??= new Promise<void>((resolve) => {
      const cancel = delay(resolve, waitMs);
      void checked
        .catch(() => {})
        .then(() => {
          cancel();
          resolve();
        });
    }));
}

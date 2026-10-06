/** Contains only daemon-owned identity, never app text or helper diagnostics. */
export class TargetBusyError extends Error {
  readonly code = "target_busy";
  readonly holder: { sessionId: string; owner: string };
  constructor(bundleId: string, sessionId: string, owner: string) {
    super(`target_busy: ${bundleId} held by ${owner} in ${sessionId}`);
    this.holder = { sessionId, owner };
  }
}

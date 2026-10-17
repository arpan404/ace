/** Caller supplies a count- and byte-bounded, identity-scoped cache. Values are untrusted. */
export interface ReadSnapshotStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

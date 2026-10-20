/**
 * Where a client keeps read snapshots of its views between sessions (ADR 0030). The caller
 * scopes it to one daemon, device and credential and bounds it by count and bytes. What `get`
 * returns is untrusted and parsed before use. `set` must copy `value` before it yields: the
 * stores it comes from keep changing. `clear` drops every record of this scope; the client calls
 * it when the daemon refuses the credential the records were read through.
 */
export interface ReadSnapshotStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  clear?(): Promise<void>;
}

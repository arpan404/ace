/*
 * One system notification per alert across this browser's tabs and windows (ADR 0195): each
 * tab hears the same alert, and the first to claim its id shows it. The claim is taken under a
 * Web Lock where the browser has them, so two tabs can't both take it; a mark in local storage
 * remembers it for a day.
 */

const prefix = "ace.notice.shown:";
const dayMs = 86_400_000;

export interface ClaimStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

export interface ClaimLocks {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

/** Whether this tab is the one to show alert `id`; false once any tab has. */
export async function claimNotice(
  id: string,
  storage: ClaimStorage | undefined,
  locks: ClaimLocks | undefined,
  now: number,
): Promise<boolean> {
  if (!storage) return true;
  const mark = () => {
    const key = prefix + id;
    if (storage.getItem(key) !== null) return false;
    forgetOld(storage, now);
    storage.setItem(key, String(now));
    return true;
  };
  if (!locks) return mark();
  return locks.request(`ace-notice:${id}`, mark);
}

function forgetOld(storage: ClaimStorage, now: number): void {
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix) && now - Number(storage.getItem(key)) > dayMs) old.push(key);
  }
  for (const key of old) storage.removeItem(key);
}

/** The browser's own: local storage and Web Locks, where it has them. */
export function browserClaim(id: string): Promise<boolean> {
  const storage = typeof localStorage === "undefined" ? undefined : localStorage;
  const locks =
    typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined;
  return claimNotice(id, storage, locks, Date.now());
}

import type { KeyValueStorage } from "@ace/ui-core";

/**
 * The browser's `localStorage` or `sessionStorage`, or an in-memory stand-in when the browser
 * denies it (a SecurityError for blocked site data, some private modes, sandboxed frames).
 * ace then works for this window and remembers nothing, instead of failing to start.
 */
export function webStorage(read: () => Storage): KeyValueStorage {
  try {
    const storage = read();
    // Reading is what throws when access is denied; some browsers only refuse on use.
    storage.getItem("ace.storage-probe");
    return storage;
  } catch {
    return memoryKeyValue();
  }
}

function memoryKeyValue(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

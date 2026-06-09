import { type OrchestrationGetThreadTimelinePageResult, type ThreadId } from "@ace/contracts";

const TIMELINE_STORAGE_DB_NAME = "ace-thread-timeline-cache";
const TIMELINE_STORAGE_DB_VERSION = 1;
const TIMELINE_THREAD_METADATA_STORE_NAME = "thread-manifests";
const TIMELINE_PAGE_STORE_NAME = "timeline-pages";

const TIMELINE_CACHE_STORAGE_KEY = "ace:timeline-cache:v1";

export interface PersistedTimelineRange {
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly cacheKey: string;
  readonly updatedAt: string;
}

export interface PersistedTimelineManifest {
  readonly threadId: ThreadId;
  readonly updatedAt: string;
  readonly totalItems: number;
  readonly tailStartIndex: number;
  readonly source: "metadata" | "hydrated" | "page";
}

export interface PersistedThreadTimelineCache {
  readonly threadId: ThreadId;
  readonly manifest: PersistedTimelineManifest;
  readonly ranges: ReadonlyArray<PersistedTimelineRange>;
  readonly lastPersistedAt: number;
}

interface TimelineThreadMetadataRecord {
  threadId: string;
  manifest: PersistedTimelineManifest;
  ranges: PersistedTimelineRange[];
  lastPersistedAt: number;
}

type SerializedThreadTimelineCache = TimelineThreadMetadataRecord;

const memoryFallbackThreadMetadata = new Map<string, string>();
const memoryFallbackPages = new Map<string, OrchestrationGetThreadTimelinePageResult>();

let openDatabasePromise: Promise<IDBDatabase | null> | null = null;

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined";
}

function readStorageValue(value: string | null): SerializedThreadTimelineCache | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed as SerializedThreadTimelineCache;
  } catch {
    return null;
  }
}

function isSerializedThreadTimelineCache(value: unknown): value is SerializedThreadTimelineCache {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    threadId?: unknown;
    manifest?: unknown;
    ranges?: unknown;
    lastPersistedAt?: unknown;
  };
  if (typeof candidate.threadId !== "string") {
    return false;
  }
  if (!candidate.manifest || typeof candidate.manifest !== "object") {
    return false;
  }
  const manifest = candidate.manifest as {
    threadId?: unknown;
    updatedAt?: unknown;
    totalItems?: unknown;
    tailStartIndex?: unknown;
    source?: unknown;
  };
  if (manifest.threadId !== candidate.threadId) {
    return false;
  }
  if (typeof manifest.updatedAt !== "string") {
    return false;
  }
  if (typeof manifest.totalItems !== "number" || manifest.totalItems < 0) {
    return false;
  }
  if (typeof manifest.tailStartIndex !== "number" || manifest.tailStartIndex < 0) {
    return false;
  }
  if (
    manifest.source !== "metadata" &&
    manifest.source !== "hydrated" &&
    manifest.source !== "page"
  ) {
    return false;
  }
  if (!Array.isArray(candidate.ranges)) {
    return false;
  }
  if (typeof candidate.lastPersistedAt !== "number") {
    return false;
  }
  return true;
}

function normalizeManifestRanges(ranges: unknown): PersistedTimelineRange[] {
  if (!Array.isArray(ranges)) {
    return [];
  }
  const next: PersistedTimelineRange[] = [];
  for (const range of ranges) {
    if (!range || typeof range !== "object") {
      continue;
    }
    const candidate = range as {
      startIndex?: unknown;
      endIndexExclusive?: unknown;
      cacheKey?: unknown;
      updatedAt?: unknown;
    };
    const startIndex = Math.max(0, Math.trunc(Number(candidate.startIndex)));
    const endIndexExclusive = Math.max(startIndex, Math.trunc(Number(candidate.endIndexExclusive)));
    const cacheKey = String(candidate.cacheKey ?? "");
    const updatedAt = String(candidate.updatedAt ?? "");
    if (!cacheKey || Number.isNaN(startIndex) || Number.isNaN(endIndexExclusive)) {
      continue;
    }
    next.push({ startIndex, endIndexExclusive, cacheKey, updatedAt });
  }
  return next;
}

function normalizePersistedThreadTimelineCache(
  value: unknown,
): PersistedThreadTimelineCache | null {
  if (!isSerializedThreadTimelineCache(value)) {
    return null;
  }
  return {
    threadId: value.threadId as ThreadId,
    manifest: {
      threadId: value.threadId as ThreadId,
      updatedAt: value.manifest.updatedAt,
      totalItems: value.manifest.totalItems,
      tailStartIndex: value.manifest.tailStartIndex,
      source: value.manifest.source,
    },
    ranges: normalizeManifestRanges(value.ranges),
    lastPersistedAt: Math.max(0, Math.trunc(value.lastPersistedAt ?? 0)),
  };
}

function isTimelinePageRecord(value: unknown): value is OrchestrationGetThreadTimelinePageResult {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    threadId?: unknown;
    startIndex?: unknown;
    endIndexExclusive?: unknown;
  };
  if (typeof candidate.threadId !== "string") {
    return false;
  }
  if (typeof candidate.startIndex !== "number" || typeof candidate.endIndexExclusive !== "number") {
    return false;
  }
  return true;
}

function openTimelineStorageDatabase(): Promise<IDBDatabase | null> {
  if (openDatabasePromise) {
    return openDatabasePromise;
  }
  if (!hasIndexedDb()) {
    openDatabasePromise = Promise.resolve(null);
    return openDatabasePromise;
  }

  openDatabasePromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(TIMELINE_STORAGE_DB_NAME, TIMELINE_STORAGE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TIMELINE_THREAD_METADATA_STORE_NAME)) {
          database.createObjectStore(TIMELINE_THREAD_METADATA_STORE_NAME);
        }
        if (!database.objectStoreNames.contains(TIMELINE_PAGE_STORE_NAME)) {
          database.createObjectStore(TIMELINE_PAGE_STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          openDatabasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });

  return openDatabasePromise;
}

async function readValueFromStore<T>(storeName: string, key: string): Promise<T | null> {
  if (typeof window === "undefined") {
    return null;
  }
  const database = await openTimelineStorageDatabase();
  if (!database) {
    const raw = memoryFallbackThreadMetadata.get(`${TIMELINE_CACHE_STORAGE_KEY}:${key}`) ?? null;
    const parsed = readStorageValue(raw);
    return (parsed as T | null) ?? null;
  }

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readonly");
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => {
        const result = request.result;
        resolve((result as T | null) ?? null);
      };
      request.onerror = () => resolve(null);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function readAllValuesFromStore<T>(
  storeName: string,
  keys: string[],
): Promise<Map<string, T>> {
  const next = new Map<string, T>();
  if (keys.length === 0) {
    return next;
  }
  if (typeof window === "undefined") {
    for (const key of keys) {
      const raw = memoryFallbackPages.get(key);
      if (raw && isTimelinePageRecord(raw)) {
        next.set(key, raw as T);
      }
    }
    return next;
  }
  const database = await openTimelineStorageDatabase();
  if (!database) {
    for (const key of keys) {
      const raw = memoryFallbackPages.get(key);
      if (raw && isTimelinePageRecord(raw)) {
        next.set(key, raw as T);
      }
    }
    return next;
  }

  return new Promise((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      for (const key of keys) {
        const request = store.get(key);
        request.onsuccess = () => {
          const result = request.result;
          if (result && isTimelinePageRecord(result)) {
            next.set(key, result as T);
          }
        };
      }
      transaction.oncomplete = () => resolve(next);
      transaction.onerror = () => resolve(next);
      transaction.onabort = () => resolve(next);
    } catch {
      resolve(next);
    }
  });
}

function scheduleStorageFallbackCommit(key: string, value: string): void {
  memoryFallbackThreadMetadata.set(`${TIMELINE_CACHE_STORAGE_KEY}:${key}`, value);
}

async function writeValueToStore<T>(storeName: string, key: string, value: T): Promise<void> {
  if (typeof window === "undefined") {
    return;
  }

  const serialized = JSON.stringify(value);
  if (storeName === TIMELINE_THREAD_METADATA_STORE_NAME) {
    scheduleStorageFallbackCommit(key, serialized);
  }

  const database = await openTimelineStorageDatabase();
  if (!database) {
    if (storeName === TIMELINE_PAGE_STORE_NAME) {
      memoryFallbackPages.set(key, value as OrchestrationGetThreadTimelinePageResult);
    }
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => resolve();
    } catch {
      if (storeName === TIMELINE_PAGE_STORE_NAME) {
        memoryFallbackPages.set(key, value as OrchestrationGetThreadTimelinePageResult);
      }
      resolve();
    }
  });
}

async function deleteValueFromStore(storeName: string, key: string): Promise<void> {
  if (storeName === TIMELINE_THREAD_METADATA_STORE_NAME) {
    memoryFallbackThreadMetadata.delete(`${TIMELINE_CACHE_STORAGE_KEY}:${key}`);
  }
  if (storeName === TIMELINE_PAGE_STORE_NAME) {
    memoryFallbackPages.delete(key);
  }

  const database = await openTimelineStorageDatabase();
  if (!database) {
    return;
  }

  await new Promise<void>((resolve) => {
    try {
      const transaction = database.transaction(storeName, "readwrite");
      const request = transaction.objectStore(storeName).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      transaction.onabort = () => resolve();
      transaction.oncomplete = () => resolve();
    } catch {
      resolve();
    }
  });
}

export async function readPersistedThreadTimelineCache(
  threadId: ThreadId,
): Promise<PersistedThreadTimelineCache | null> {
  if (typeof threadId !== "string") {
    return null;
  }
  const raw = await readValueFromStore<unknown>(
    TIMELINE_THREAD_METADATA_STORE_NAME,
    String(threadId),
  );
  return normalizePersistedThreadTimelineCache(raw);
}

export async function writePersistedThreadTimelineCache(
  snapshot: PersistedThreadTimelineCache,
): Promise<void> {
  if (typeof snapshot.threadId !== "string") {
    return;
  }
  const next = {
    threadId: snapshot.manifest.threadId,
    manifest: snapshot.manifest,
    ranges: [...snapshot.ranges].toSorted((left, right) => left.startIndex - right.startIndex),
    lastPersistedAt: snapshot.lastPersistedAt,
  };
  const previous = await readPersistedThreadTimelineCache(snapshot.threadId);
  if (!previous && next.ranges.length === 0) {
    return;
  }
  await writeValueToStore(TIMELINE_THREAD_METADATA_STORE_NAME, String(snapshot.threadId), next);
  if (!previous) {
    return;
  }
  const nextKeys = new Set(next.ranges.map((range) => range.cacheKey));
  const keysToDelete = previous.ranges
    .map((range) => range.cacheKey)
    .filter((cacheKey) => !nextKeys.has(cacheKey));
  for (const cacheKey of keysToDelete) {
    await deleteThreadTimelinePage(cacheKey);
  }
}

export async function clearPersistedThreadTimelineCache(threadId: ThreadId): Promise<void> {
  const snapshot = await readPersistedThreadTimelineCache(threadId);
  if (snapshot) {
    for (const range of snapshot.ranges) {
      await deleteThreadTimelinePage(range.cacheKey);
    }
  }
  await deleteValueFromStore(TIMELINE_THREAD_METADATA_STORE_NAME, String(threadId));
}

export async function writePersistedThreadTimelinePage(
  cacheKey: string,
  page: OrchestrationGetThreadTimelinePageResult,
): Promise<void> {
  if (!cacheKey || !page) {
    return;
  }
  await writeValueToStore(TIMELINE_PAGE_STORE_NAME, cacheKey, page);
}

export async function readPersistedThreadTimelinePages(
  cacheKeys: string[],
): Promise<Map<string, OrchestrationGetThreadTimelinePageResult>> {
  const normalizedKeys = cacheKeys.filter(Boolean);
  if (normalizedKeys.length === 0) {
    return new Map();
  }
  return readAllValuesFromStore<OrchestrationGetThreadTimelinePageResult>(
    TIMELINE_PAGE_STORE_NAME,
    normalizedKeys,
  );
}

export async function deleteThreadTimelinePage(cacheKey: string): Promise<void> {
  await deleteValueFromStore(TIMELINE_PAGE_STORE_NAME, cacheKey);
}

export function readAllPersistedTimelineCacheKeysForStorage(): string[] {
  if (typeof window === "undefined") {
    return [...memoryFallbackThreadMetadata.keys()];
  }
  return [];
}

export { TIMELINE_CACHE_STORAGE_KEY };

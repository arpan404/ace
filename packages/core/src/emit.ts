import type { EventPayload } from "@ace/protocol";

/** Events are snapshots, even when the reducer subsequently mutates state. */
export function emit(events: EventPayload[], payload: EventPayload): void {
  events.push(structuredClone(payload));
}

/** Native keys may be JavaScript prototype property names, also after restore. */
export function get<T>(records: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(records, key) ? records[key] : undefined;
}

export function put<T>(records: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(records, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

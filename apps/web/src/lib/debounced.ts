import { useEffect, useState } from "react";

/** How long typing settles before a search goes out (a thread's ⌘F, More › Search). */
export const searchSettleMs = 180;

/** `value` once it has stopped changing for `ms`; the first value at once. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

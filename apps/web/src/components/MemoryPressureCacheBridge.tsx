import { useEffect } from "react";

import { runMemoryPressureHandlers, subscribeToMemoryPressure } from "../lib/memoryPressure";

export function MemoryPressureCacheBridge() {
  useEffect(
    () =>
      subscribeToMemoryPressure((snapshot) => {
        if (snapshot !== null) {
          runMemoryPressureHandlers(snapshot);
        }
      }),
    [],
  );

  return null;
}

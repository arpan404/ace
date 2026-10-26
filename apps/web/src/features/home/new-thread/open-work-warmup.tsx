import { Suspense, useEffect, useState } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";

const Warm = deferredComponent(() => import("./open-work-warm.tsx").then((m) => m.WarmOpenWork));

/**
 * Loads the open work (pull requests and issues) of the project New thread would open on, once
 * the app is idle, and keeps it cached, so New thread shows it at once instead of after a GitHub
 * round trip. It renders nothing. Its code loads when the app is idle too, so the forge schemas
 * stay out of the first paint.
 */
export function OpenWorkWarmup() {
  const [idle, setIdle] = useState(false);
  useEffect(() => whenIdle(() => setIdle(true)), []);
  if (!idle) return null;
  return (
    <Suspense fallback={null}>
      <Warm.Component />
    </Suspense>
  );
}

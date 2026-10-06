import { Suspense, useEffect, useState } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { whenIdle } from "@/lib/idle.ts";

const Indicator = deferredComponent(() => import("./indicator.tsx").then((m) => m.default));

/**
 * The computer-use indicator, mounted once the app is idle after its first paint: it opens the
 * screen channel and draws nothing until an agent is using an app or a browser.
 */
export function ComputerUseIndicator() {
  const [ready, setReady] = useState(false);
  useEffect(() => whenIdle(() => setReady(true)), []);
  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <Indicator.Component />
    </Suspense>
  );
}

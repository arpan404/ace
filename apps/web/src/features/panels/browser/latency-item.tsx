import { MenuGroup, MenuLabel } from "@/components/ui/menu.tsx";
import { useLocal } from "../store.ts";
import { inputLatency } from "./use-local-echo.ts";

/**
 * The ⋯ menu's round trip of the person's input to the page (sent to answered), once they have
 * used it in this thread. Mounted only while the menu is open, so input never re-renders it.
 */
export function LatencyItem(props: { threadId: string }) {
  const latency = useLocal(inputLatency, (map) => map.get(props.threadId));
  if (latency === undefined) return null;
  return (
    <MenuGroup>
      <MenuLabel className="tabular-nums">Input round trip {latency} ms</MenuLabel>
    </MenuGroup>
  );
}

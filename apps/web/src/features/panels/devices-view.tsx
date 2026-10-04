import { DevicesTab } from "@/features/devices/index.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";

/** The Devices tool as a workspace tab (its own chunk, with the devices channel). */
export function DevicesView(props: TabViewProps) {
  return <DevicesTab threadId={props.scope} />;
}

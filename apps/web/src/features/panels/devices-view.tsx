import { DeviceTab, DevicesTab } from "@/features/devices/index.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";

/** The Devices catalog as a workspace tab (its own chunk, with the devices channel). */
export function DevicesView(props: TabViewProps) {
  return <DevicesTab threadId={props.scope} />;
}

/** One simulator or emulator as a workspace tab; its id is the device's. */
export function DeviceView(props: TabViewProps) {
  return (
    <DeviceTab
      threadId={props.scope}
      deviceId={props.tab.id}
      name={props.tab.title}
      tabKey={props.tab.key}
    />
  );
}

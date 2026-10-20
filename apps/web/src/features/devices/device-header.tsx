import { CaretLeftIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";

/**
 * The device tab's header: back to the list, the device's name with a line about it ("iOS 18.4
 * · Live · H.264 · 59 fps · 35 ms"), then ⋯. There is no control switch: the person's input
 * drives the device as soon as it is live.
 */
export function DeviceHeader(props: {
  name: string;
  subtitle: readonly string[];
  busy: boolean;
  onBack(): void;
  menu: ReactNode;
}) {
  return (
    <header className={cn("flex h-11 shrink-0 items-center gap-1.5 pr-1.5 pl-1", toolbarEdge)}>
      <IconButton icon={CaretLeftIcon} label="All devices" onClick={props.onBack} />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-ui font-medium text-foreground">{props.name}</h2>
        <p className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground tabular-nums">
          {props.busy && <Spinner />}
          <span className="truncate">{props.subtitle.join(" · ")}</span>
        </p>
      </div>
      {props.menu}
    </header>
  );
}

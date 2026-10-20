import { leaseLeft } from "@ace/ui-core";
import { ArrowUUpLeftIcon, CaretLeftIcon, HandGrabbingIcon, HandIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { DelegateItems } from "@/components/agent-picker.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { SplitButton } from "@/components/ui/split-button.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { keymap } from "@/lib/keymap.ts";
import { AgentDriver, type Controller } from "./controller-label.tsx";

/** Who drives the device, as a small chip: "You · 4:12" or the agent; nothing when no one. */
function ControlChip(props: { controller: Controller; leaseLeftMs: number }) {
  const { controller } = props;
  if (controller.kind === "nobody") return null;
  return (
    <span
      role="status"
      aria-label={
        controller.kind === "you"
          ? "You're in control"
          : controller.kind === "other"
            ? "Another connection is in control"
            : undefined
      }
      className="inline-flex h-6 max-w-44 min-w-0 shrink items-center gap-1.5 rounded-sm bg-fill px-2 text-xs text-muted-foreground"
    >
      {controller.kind === "agent" ? (
        <AgentDriver threadId={controller.threadId} agentId={controller.agentId} />
      ) : controller.kind === "you" ? (
        <>
          <span className="text-foreground">You</span>
          {props.leaseLeftMs > 0 && (
            <span className="text-subtle-foreground tabular-nums">
              {leaseLeft(props.leaseLeftMs)}
            </span>
          )}
        </>
      ) : (
        <span className="truncate">Another connection</span>
      )}
    </span>
  );
}

/**
 * The control action beside the chip: Take control when no one drives, Take over from an agent,
 * Hand back while you drive; its caret delegates the device to one of the thread's agents.
 */
function ControlAction(props: {
  controller: Controller;
  threadId: string;
  disabled: boolean;
  onTake(): void;
  onRelease(): void;
  onDelegate(agentId: string): void;
}) {
  const you = props.controller.kind === "you";
  const agent = props.controller.kind === "agent";
  const label = you ? "Hand back" : agent ? "Take over" : "Take control";
  return (
    <SplitButton
      icon={
        you ? (
          <ArrowUUpLeftIcon aria-hidden size={14} />
        ) : agent ? (
          <HandGrabbingIcon aria-hidden size={14} />
        ) : (
          <HandIcon aria-hidden size={14} />
        )
      }
      label={label}
      labelClassName="@max-[30rem]/devicehead:sr-only"
      actionLabel={label}
      menuLabel="Delegate to an agent"
      shortcut={keymap.takeControl.keys}
      disabled={props.disabled}
      onAction={you ? props.onRelease : props.onTake}
      menu={
        <DelegateItems
          threadId={props.threadId}
          disabled={props.disabled}
          onDelegate={props.onDelegate}
          empty={<MenuItem disabled>No agents in this thread yet</MenuItem>}
        />
      }
    />
  );
}

/**
 * The device tab's header: back to the list, the device's name with a line about it ("iOS 18.4
 * · Live · H.264 · 59 fps · 35 ms"), who drives it and the control action, then ⋯.
 */
export function DeviceHeader(props: {
  name: string;
  subtitle: readonly string[];
  busy: boolean;
  onBack(): void;
  /** Who drives the device and, while it runs, how to change that. */
  control: {
    running: boolean;
    controller: Controller;
    leaseLeftMs: number;
    threadId: string;
    disabled: boolean;
    onTake(): void;
    onRelease(): void;
    onDelegate(agentId: string): void;
  };
  menu: ReactNode;
}) {
  const { control } = props;
  return (
    <header
      className={cn(
        "@container/devicehead flex h-11 shrink-0 items-center gap-1.5 pr-1.5 pl-1",
        toolbarEdge,
      )}
    >
      <IconButton icon={CaretLeftIcon} label="All devices" onClick={props.onBack} />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate text-ui font-medium text-foreground">{props.name}</h2>
        <p className="flex min-w-0 items-center gap-1 text-xs text-subtle-foreground tabular-nums">
          {props.busy && <Spinner />}
          <span className="truncate">{props.subtitle.join(" · ")}</span>
        </p>
      </div>
      <ControlChip controller={control.controller} leaseLeftMs={control.leaseLeftMs} />
      {control.running && (
        <ControlAction
          controller={control.controller}
          threadId={control.threadId}
          disabled={control.disabled}
          onTake={control.onTake}
          onRelease={control.onRelease}
          onDelegate={control.onDelegate}
        />
      )}
      {props.menu}
    </header>
  );
}

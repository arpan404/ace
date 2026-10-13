import type { ReactElement } from "react";
import { Button } from "@/components/ui/button.tsx";
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

export interface StopConfirmProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Stop's own button, which becomes the popover's trigger. */
  trigger: ReactElement;
  label: string;
  stopping: boolean;
  onStop(): void;
}

/**
 * The question Stop asks before it stops an agent's subagents too. It loads on first use, so the
 * popover stays out of the first paint while Stop itself draws eagerly.
 */
export function StopConfirm(props: StopConfirmProps) {
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <Tip label={props.label}>
        <PopoverTrigger render={props.trigger} />
      </Tip>
      <PopoverContent align="end" className="w-[260px]">
        <PopoverTitle className="text-ui font-medium">{props.label}?</PopoverTitle>
        <PopoverDescription className="mt-1 text-sm text-muted-foreground">
          Their work so far stays in the thread.
        </PopoverDescription>
        <div className="mt-3 flex justify-end gap-2">
          <PopoverClose render={<Button size="sm" variant="ghost" />}>Cancel</PopoverClose>
          <Button size="sm" variant="danger" disabled={props.stopping} onClick={props.onStop}>
            Stop all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

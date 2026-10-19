import { StackIcon } from "@phosphor-icons/react";
import type { ForgePrDetail } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { PrStack } from "./pr-stack.tsx";

/**
 * The header's stack chip, "2/5" for the second of five layers. It opens the stack: its layers,
 * their merge rules and the stack's own writes. Kept mounted while closed so a confirmation in
 * progress survives closing it.
 */
export function PrStackChip(props: {
  workspaceId: string;
  detail: ForgePrDetail;
  stack: { number: number; size: number; position: number };
  onRefresh(): void;
  onOpen(number: number): void;
}) {
  const { stack } = props;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Stack #${stack.number}, layer ${stack.position} of ${stack.size}`}
          />
        }
      >
        <StackIcon aria-hidden size={14} />
        <span className="tabular-nums">{`${stack.position}/${stack.size}`}</span>
      </PopoverTrigger>
      <PopoverContent align="end" keepMounted className="w-96 max-w-[calc(100vw-2rem)] p-3">
        <PrStack
          key={`stack:${JSON.stringify(props.detail.status.ref)}`}
          workspaceId={props.workspaceId}
          detail={props.detail}
          onRefresh={props.onRefresh}
          onOpen={props.onOpen}
        />
      </PopoverContent>
    </Popover>
  );
}

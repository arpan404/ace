"use client";

import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { useBoundaryDismissedOpen } from "./floatingBoundaryDismiss";
import { PopoverPopup } from "./popoverPopup";
import { PopoverTrigger } from "./popoverTrigger";

function Popover<Payload = unknown>({
  defaultOpen,
  onOpenChange,
  open,
  ...props
}: PopoverPrimitive.Root.Props<Payload>) {
  const boundaryDismissedOpen = useBoundaryDismissedOpen<PopoverPrimitive.Root.ChangeEventDetails>({
    defaultOpen,
    onOpenChange,
    open,
  });

  return <PopoverPrimitive.Root {...boundaryDismissedOpen} {...props} />;
}

export { Popover, PopoverTrigger, PopoverPopup };

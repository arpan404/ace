"use client";

import * as React from "react";

type OpenChangeHandler<Details> = (open: boolean, eventDetails: Details) => void;

function createSyntheticOpenChangeDetails<Details>(
  reason: "focus-out" | "window-resize",
  event: Event,
): Details {
  return {
    reason,
    event,
    cancel: () => undefined,
    allowPropagation: () => undefined,
    isCanceled: false,
    isPropagationAllowed: false,
    trigger: undefined,
    preventUnmountOnClose: () => undefined,
  } as Details;
}

export function useBoundaryDismissedOpen<Details>(input: {
  defaultOpen?: boolean | undefined;
  onOpenChange?: OpenChangeHandler<Details> | undefined;
  open?: boolean | undefined;
}) {
  const { defaultOpen, onOpenChange: onInputOpenChange, open: controlledOpen } = input;
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const open = controlledOpen ?? uncontrolledOpen;

  const onOpenChange = React.useCallback<OpenChangeHandler<Details>>(
    (nextOpen, eventDetails) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onInputOpenChange?.(nextOpen, eventDetails);
    },
    [onInputOpenChange, isControlled],
  );

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const closeForBoundary = (reason: "focus-out" | "window-resize", event: Event) => {
      onOpenChange(false, createSyntheticOpenChangeDetails<Details>(reason, event));
    };
    const handleBlur = (event: FocusEvent) => closeForBoundary("focus-out", event);
    const handleNativeResizeStart = (event: Event) => closeForBoundary("window-resize", event);
    const handleVisibilityChange = (event: Event) => {
      if (document.visibilityState === "hidden") {
        closeForBoundary("focus-out", event);
      }
    };

    window.addEventListener("blur", handleBlur);
    window.addEventListener("ace:native-window-resize-start", handleNativeResizeStart);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("ace:native-window-resize-start", handleNativeResizeStart);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [onOpenChange, open]);

  return { open, onOpenChange };
}

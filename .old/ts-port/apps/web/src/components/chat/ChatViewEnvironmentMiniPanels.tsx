import { type ComponentProps, type Ref } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence } from "motion/react";

import { EnvironmentMiniPanel } from "./EnvironmentMiniPanel";

type EnvironmentMiniPanelBaseProps = Omit<
  ComponentProps<typeof EnvironmentMiniPanel>,
  "layoutMode" | "style"
>;

export function EnvironmentMiniPanelPortal({
  open,
  panelProps,
  panelRef,
  style,
}: {
  open: boolean;
  panelProps: EnvironmentMiniPanelBaseProps | null;
  panelRef: Ref<HTMLElement>;
  style: ComponentProps<typeof EnvironmentMiniPanel>["style"] | null;
}) {
  if (!open || !panelProps || !style || typeof document === "undefined") {
    return null;
  }
  return createPortal(
    <AnimatePresence initial={false}>
      <EnvironmentMiniPanel
        key="environment-mini-panel-popover"
        ref={panelRef}
        {...panelProps}
        layoutMode="popover"
        style={style}
      />
    </AnimatePresence>,
    document.body,
  );
}

export function InlineEnvironmentMiniPanel({
  open,
  panelProps,
}: {
  open: boolean;
  panelProps: EnvironmentMiniPanelBaseProps | null;
}) {
  return (
    <AnimatePresence initial={false}>
      {open && panelProps ? (
        <EnvironmentMiniPanel
          key="environment-mini-panel-inline"
          {...panelProps}
          layoutMode="inline"
        />
      ) : null}
    </AnimatePresence>
  );
}

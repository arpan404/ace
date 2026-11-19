import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { deferredPart, usePart } from "@/lib/deferred-part.ts";
import type { KeymapId } from "@/lib/keymap.ts";
import { Kbd } from "./kbd.tsx";
import { useOpenGate } from "./open-gate.ts";
import { QuietBoundary } from "./quiet-boundary.tsx";

export const TooltipSide = createContext<TooltipPrimitive.Positioner.Props["side"]>("bottom");

/**
 * The popup's code (its Floating UI placement) is out of the first paint: it loads once the
 * browser is idle, or when a tooltip first asks to open, and the tooltip opens once it is in.
 */
// Pure: a call the bundler must keep would hold the popup's loader in every chunk that imports this.
const Popup = /* @__PURE__ */ deferredComponent(() =>
  import("./tooltip-popup.tsx").then((module) => module.TooltipPopup),
);
const popup = /* @__PURE__ */ deferredPart(Popup.preload);

function TooltipProvider({ delay = 500, ...props }: TooltipPrimitive.Provider.Props) {
  useEffect(() => popup.warm(), []);
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

/** Whether the tooltip around a popup is open, so a popup that failed to draw tries again. */
const TooltipOpen = createContext(false);

/** Opens its tooltip through Base UI's own open, as a request held by `useOpenGate` asked. */
class ReplayHandle extends TooltipPrimitive.Handle<unknown> {
  replay(details: TooltipPrimitive.Root.ChangeEventDetails) {
    this.attachedStore?.setOpen(true, details);
  }
}

/** A tooltip's root; it opens only once its popup's code has arrived (`useOpenGate`). */
function Tooltip(props: TooltipPrimitive.Root.Props) {
  const [handle] = useState(() => new ReplayHandle());
  const gate = useOpenGate(popup, { ...props, replay: (details) => handle.replay(details) });
  return (
    <TooltipOpen value={gate.open}>
      <TooltipPrimitive.Root
        {...props}
        handle={handle}
        open={gate.open}
        onOpenChange={gate.onOpenChange}
      />
    </TooltipOpen>
  );
}

function TooltipContent(props: ComponentProps<typeof Popup.Component>) {
  const ready = usePart(popup) !== undefined;
  const open = useContext(TooltipOpen);
  // Mounted once the code is in, so it renders at once, never suspending under an open tooltip.
  if (!ready) return null;
  return (
    <QuietBoundary retryWhen={open}>
      <Popup.Component {...props} />
    </QuietBoundary>
  );
}

/**
 * A tooltip around one trigger element, with the shortcut that does the same thing. Pass a
 * keymap id (`shortcut="agents"`) or keys (`keys="mod+enter"`); either follows the user's
 * rebinding, unless `resolve={false}` marks `keys` as a local command's own (find-bar Enter).
 */
function Tip(props: {
  label: ReactNode;
  shortcut?: KeymapId;
  keys?: string;
  /** False: `keys` are this control's own, never a rebindable shortcut's. */
  resolve?: boolean;
  side?: TooltipPrimitive.Positioner.Props["side"];
  /** A related popup already owns the trigger's description while it is open. */
  disabled?: boolean;
  children: ReactElement;
}) {
  const side = useContext(TooltipSide);
  return (
    <Tooltip
      disabled={props.disabled}
      onOpenChange={(open, details) => {
        // A tooltip is only a description. Escape must still reach the dialog or
        // menu containing its trigger after dismissing that description.
        if (details.reason === "escape-key") details.allowPropagation();
        if (open && behindOpenPopup(details.trigger ?? eventElement(details.event)))
          details.cancel();
      }}
    >
      <TooltipPrimitive.Trigger render={props.children} closeOnClick />
      <TooltipContent side={props.side ?? side}>
        <div className="min-w-0 break-words">{props.label}</div>
        {props.shortcut ? (
          <Kbd shortcut={props.shortcut} />
        ) : (
          props.keys && <Kbd keys={props.keys} resolve={props.resolve ?? true} />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** Popups whose own controls may still describe themselves while they are open. */
const popupContent = '[role="menu"], [role="listbox"], [role="dialog"], [data-slot="model-picker"]';

function eventElement(event: Event | undefined): Element | undefined {
  return event?.target instanceof Element ? event.target : undefined;
}

/**
 * While a menu or popover is open, the controls behind it keep their tooltips to themselves
 * (the Approvals tip never sits beside an open + menu); controls inside the popup still show
 * theirs.
 */
function behindOpenPopup(trigger: Element | undefined): boolean {
  if (!trigger || trigger.closest(popupContent)) return false;
  // A menu or popover trigger with its popup open (a tooltip's own trigger has no
  // aria-expanded), or a combobox showing its list (the composer's +).
  const open = trigger.ownerDocument.querySelector(
    '[data-popup-open][aria-expanded="true"], [aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]',
  );
  return open !== null && open !== trigger && !open.contains(trigger);
}

const TooltipTrigger = TooltipPrimitive.Trigger;

export { Tip, Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

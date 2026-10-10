import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "@phosphor-icons/react";
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type RefObject,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn.ts";
import { matchesChord } from "@/lib/hotkeys.ts";
import { parseChord } from "@/lib/keymap.ts";
import { IconButton } from "./icon-button.tsx";
import { Kbd } from "./kbd.tsx";
import { layers } from "./menu-styles.ts";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        layers.overlay,
        "fixed inset-0 bg-black/50 [-webkit-app-region:no-drag] transition-opacity duration-(--dur-2) ease-smooth data-ending-style:opacity-0 data-ending-style:duration-(--dur-exit) data-starting-style:opacity-0",
        className,
      )}
      {...props}
      style={{ backgroundColor: "rgb(0 0 0 / 60%)", ...props.style }}
    />
  );
}

/** Widths: confirmations and short forms; forms with a list; pickers and reviews. */
const sizes = {
  sm: "w-[min(420px,calc(100vw-2rem))]",
  md: "w-[min(480px,calc(100vw-2rem))]",
  lg: "w-[min(640px,calc(100vw-2rem))]",
} as const;

/**
 * Notes what had focus as the popup mounts (each time the dialog opens). Children's layout
 * effects run before Base UI's focus manager, an ancestor, moves focus inside.
 */
function OpenerProbe(props: { openerRef: RefObject<HTMLElement | null> }) {
  const { openerRef } = props;
  useLayoutEffect(() => {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [openerRef]);
  return null;
}

/**
 * Modal card. Base UI traps focus; on close it returns to whatever had focus when the dialog
 * opened, so dialogs opened by a shortcut or from a menu behave like triggered ones. The card
 * is never taller than the window: its content scrolls, or only `DialogBody` does when used.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  size = "sm",
  finalFocus,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  size?: keyof typeof sizes;
}) {
  const openerRef = useRef<HTMLElement | null>(null);
  // Back to the opener while it's still on the page, else where Base UI would put it.
  const returnFocus = useCallback(() => {
    const element = openerRef.current;
    return element?.isConnected ? element : true;
  }, []);
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-size={size}
        finalFocus={finalFocus ?? returnFocus}
        className={cn(
          layers.modal,
          "glass fixed top-1/2 left-1/2 flex max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-contain rounded-xl bg-popover p-5 text-ui text-popover-foreground outline-none [-webkit-app-region:no-drag]",
          "transition-[opacity,transform] duration-(--dur-2) ease-spring data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-ending-style:duration-(--dur-exit) data-ending-style:ease-exit data-starting-style:translate-y-[calc(-50%+var(--rise))] data-starting-style:scale-[0.97] data-starting-style:opacity-0",
          sizes[size],
          className,
        )}
        {...props}
      >
        <OpenerProbe openerRef={openerRef} />
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            render={
              <IconButton icon={XIcon} label="Close" size="sm" className="absolute top-3 right-3" />
            }
          />
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex shrink-0 flex-col gap-1 pr-8", className)} {...props} />;
}

/**
 * The part of a dialog that scrolls when the window is short, so the title and the footer's
 * buttons stay in view. Without it the whole card scrolls.
 */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        "-mx-5 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-5",
        className,
      )}
      {...props}
    />
  );
}

const submitChord = parseChord("mod+enter");

/**
 * Ghost "Cancel" first, then one primary or danger action. `submitHint`: ⌘↵ anywhere in the
 * dialog presses the last button, which shows the hint.
 */
function DialogFooter({
  className,
  submitHint = false,
  children,
  ...props
}: React.ComponentProps<"div"> & { submitHint?: boolean }) {
  const footer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = footer.current;
    const dialog = element?.closest<HTMLElement>("[data-slot=dialog-content]");
    if (!submitHint || !element || !dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !matchesChord(event, submitChord)) return;
      const buttons = element.querySelectorAll<HTMLButtonElement>("button");
      const primary = buttons[buttons.length - 1];
      if (!primary || primary.disabled || primary.getAttribute("aria-disabled") === "true") return;
      event.preventDefault();
      primary.click();
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => dialog.removeEventListener("keydown", onKeyDown);
  }, [submitHint]);
  return (
    <div
      ref={footer}
      data-slot="dialog-footer"
      className={cn("flex shrink-0 justify-end gap-2 pt-1", className)}
      {...props}
    >
      {submitHint ? withSubmitHint(children) : children}
    </div>
  );
}

/** Appends the ⌘↵ hint inside the footer's last element (its primary button). */
function withSubmitHint(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  const last = items.at(-1);
  if (!isValidElement<{ children?: ReactNode }>(last)) return children;
  const hinted = cloneElement(last as ReactElement<{ children?: ReactNode }>, {
    children: (
      <>
        {last.props.children}
        {/* A hint for the eye only: the button's name stays its label ("Commit"). */}
        <Kbd aria-hidden variant="on-primary" resolve={false} keys="mod+enter" />
      </>
    ),
  });
  return [...items.slice(0, -1), hinted];
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn("text-md font-medium tracking-[-0.005em]", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-ui leading-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};

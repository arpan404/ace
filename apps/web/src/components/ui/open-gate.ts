import { useEffect, useRef, useState } from "react";
import { usePart, type DeferredPart } from "@/lib/deferred-part.ts";

/** What a Base UI root passes with each open change, as far as the gate needs it. */
interface ChangeDetails {
  readonly isCanceled: boolean;
  cancel(): void;
  readonly event: Event;
  readonly trigger?: Element | undefined;
}

/** The same request again, cancellable afresh, for when it is handed on after a wait. */
function reissued<D extends ChangeDetails>(details: D): D {
  let canceled = false;
  return {
    ...details,
    cancel() {
      canceled = true;
    },
    get isCanceled() {
      return canceled;
    },
  };
}

/**
 * Holds a hover popup closed until its deferred code (`part`) has arrived, then opens it whole,
 * with its usual opening animation, never as an empty popup that fills in. A request to open
 * that comes first is remembered and, once the code is in, `replay` hands it back to Base UI's
 * own open (the root's store), with its reason, event and trigger, so it opens exactly as it
 * would have with the code already there: a keyboard focus open still skips the animation. It
 * is dropped if the pointer leaves, focus moves, or Escape or any activation (a press, Enter,
 * Space, an assistive technology's click) comes first. A failed load leaves it closed, and the
 * next hover tries again. Spread the result onto the root, which stays as controlled (or not) as
 * its caller made it.
 */
export function useOpenGate<D extends ChangeDetails>(
  part: DeferredPart<unknown>,
  props: {
    open?: boolean | undefined;
    defaultOpen?: boolean | undefined;
    onOpenChange?: ((open: boolean, details: D) => void) | undefined;
    /** Opens the root through Base UI's own open, as `details` asked (`ReplayHandle`). */
    replay: (details: D) => void;
  },
): { open: boolean; onOpenChange(open: boolean, details: D): void } {
  const ready = usePart(part) !== undefined;
  const [own, setOwn] = useState(props.defaultOpen ?? false);
  const controlled = props.open !== undefined;
  const wanted = controlled ? props.open === true : own;
  const pending = useRef<(() => void) | undefined>(undefined);
  // A trigger pressed while its popup was loading, until the pointer leaves it: as Base UI does
  // after a press on an open tooltip, it doesn't open again under a pointer still resting there.
  const pressed = useRef<Element | undefined>(undefined);
  // An open handed on after a wait reaches the caller as it is then, not as it was when asked.
  const latest = useRef({ onOpenChange: props.onOpenChange, controlled, replay: props.replay });
  useEffect(() => {
    latest.current = { onOpenChange: props.onOpenChange, controlled, replay: props.replay };
  });
  // Opened from outside (`open` or `defaultOpen`) before the code: it shows once the code is in.
  useEffect(() => {
    if (wanted && !ready) void part.load().catch(() => {});
  }, [wanted, ready, part]);
  useEffect(() => () => pending.current?.(), []);

  const deliver = (next: boolean, details: D) => {
    const caller = latest.current;
    caller.onOpenChange?.(next, details);
    if (!details.isCanceled && !caller.controlled) setOwn(next);
  };
  const onOpenChange = (next: boolean, details: D) => {
    pending.current?.();
    const trigger =
      details.trigger ?? (details.event.target instanceof Element ? details.event.target : null);
    if (next && trigger && pressed.current === trigger) return details.cancel();
    if (!next || part.current() !== undefined) return deliver(next, details);
    // Base UI stays closed; the open goes on once the code arrives, if nothing cancelled it.
    details.cancel();
    const doc = trigger?.ownerDocument ?? document;
    let live = true;
    const cancel = () => {
      live = false;
      if (pending.current === cancel) pending.current = undefined;
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPress, true);
      doc.removeEventListener("click", cancel, true);
      trigger?.removeEventListener("pointerleave", cancel);
      trigger?.removeEventListener("focusout", cancel);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    const onPress = (event: PointerEvent) => {
      cancel();
      if (!trigger || !(event.target instanceof Node) || !trigger.contains(event.target)) return;
      pressed.current = trigger;
      const release = () => {
        if (pressed.current === trigger) pressed.current = undefined;
      };
      trigger.addEventListener("pointerleave", release, { once: true });
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPress, true);
    // Any activation, by pointer, Enter or Space, or an assistive technology, which click alone
    // carries; a pointer's press came first and is already handled.
    doc.addEventListener("click", cancel, true);
    trigger?.addEventListener("pointerleave", cancel);
    trigger?.addEventListener("focusout", cancel);
    pending.current = cancel;
    part.load().then(() => {
      if (!live) return;
      cancel();
      // Back through Base UI, which calls this handler again, now with the code in.
      latest.current.replay(reissued(details));
    }, cancel);
  };
  return { open: wanted && ready, onOpenChange };
}

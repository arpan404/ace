import { useEffect, useEffectEvent, useLayoutEffect, useState, type RefObject } from "react";

/*
 * A popup opened from an always-present button while its code is still loading. Until the popup
 * exists, these stand in for what it would do: Escape or a press elsewhere cancels the open, and
 * once it arrives it opens as if it had been there all along. (A failed load closes it and the
 * next open tries again: `RecoverableBoundary`'s `onFailed` and `retryWhen`.)
 */

/**
 * While the popup's code loads after an open (a Suspense fallback), Escape or a press outside
 * `anchor` cancels the open, as the popup itself would. Escape is taken here, so nothing behind
 * the popup acts on it too.
 */
export function PendingDismiss(props: {
  anchor: RefObject<HTMLElement | null>;
  onDismiss(): void;
}) {
  const dismiss = useEffectEvent(() => props.onDismiss());
  const { anchor } = props;
  useEffect(() => {
    const doc = anchor.current?.ownerDocument ?? document;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      dismiss();
    };
    const onPress = (event: PointerEvent) => {
      // The button toggles itself; a press on it is not a press elsewhere.
      if (event.target instanceof Node && anchor.current?.contains(event.target)) return;
      dismiss();
    };
    doc.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onPress, true);
    return () => {
      doc.removeEventListener("keydown", onKey, true);
      doc.removeEventListener("pointerdown", onPress, true);
    };
  }, [anchor]);
  return null;
}

/**
 * `open` for a popup root that has just mounted: closed on its first commit, then `open` before
 * the browser paints. A root that mounts already open skips its opening transition; one that
 * opens after mounting plays it, as when it had been mounted all along.
 */
export function useOpenAfterMount(open: boolean): { mounted: boolean; open: boolean } {
  const [mounted, setMounted] = useState(false);
  useLayoutEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react-compiler/set-state-in-effect -- one commit closed, then open, before paint.
    setMounted(true);
  }, []);
  return { mounted, open: mounted && open };
}

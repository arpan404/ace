import { useRef, useState, type FocusEvent } from "react";

/**
 * Whether the row is under the pointer or holds keyboard focus. While it is, the row's hover
 * actions take the status slot and the status steps aside. Keyboard focus is the row's own link
 * (`data-row-focus`) reached without a press: the actions are out of the tab order, so focus a
 * click leaves on the row or a menu hands back to its ⋯ doesn't hold the status away once the
 * pointer moves off. The handlers go on the row's outer box.
 */
export function useRowActive() {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  // A press focuses before it ends, so the focus it brings is known by the press still being down.
  const pressing = useRef(false);
  return {
    active: pointer || focus,
    handlers: {
      onPointerEnter: () => setPointer(true),
      onPointerLeave: () => {
        pressing.current = false;
        setPointer(false);
      },
      // Capture: the actions stop their presses from reaching the row.
      onPointerDownCapture: () => {
        pressing.current = true;
      },
      onPointerUpCapture: () => {
        pressing.current = false;
      },
      onFocus: (event: FocusEvent<HTMLElement>) => {
        const link =
          event.target instanceof HTMLElement && event.target.hasAttribute("data-row-focus");
        if (link && !pressing.current) setFocus(true);
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocus(false);
      },
    },
  };
}

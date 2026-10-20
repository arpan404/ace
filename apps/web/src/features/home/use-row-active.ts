import { useRef, useState, type FocusEvent, type PointerEvent } from "react";

/**
 * Whether the row is under the pointer or holds keyboard focus. While it is, the row's hover
 * actions take the status slot and the status steps aside. Keyboard focus is the row's own link
 * (`data-row-focus`) reached without a press: the actions are out of the tab order, so focus a
 * click leaves on the row or a menu hands back to its ⋯ doesn't hold the status away once the
 * pointer moves off. Nor does the focus the window hands back when the app comes to the front
 * again: that restores what the row showed before. The handlers go on the row's outer box.
 */
export function useRowActive() {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  // A press focuses before it ends, so the focus it brings is known by the press still being down.
  const pressing = useRef(false);
  // Set while the window is away with focus still on the row's link: what focus showed then.
  const away = useRef<boolean | undefined>(undefined);
  return {
    active: pointer || focus,
    handlers: {
      // The actions' menus render elsewhere in the page but bubble here through React, so the
      // pointer counts as on the row only over the row's own elements. A menu that closes under
      // the pointer then leaves nothing for the row to wait on a leave for.
      onPointerOver: (event: PointerEvent<HTMLElement>) => {
        const target = event.target;
        setPointer(target instanceof Node && event.currentTarget.contains(target));
      },
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
        const target = event.target;
        const link = target instanceof HTMLElement && target.hasAttribute("data-row-focus");
        const restored = away.current;
        away.current = undefined;
        // The window hands focus back from nowhere; moving between rows comes from another row.
        if (restored !== undefined && event.relatedTarget === null) setFocus(restored);
        else if (link && !pressing.current) setFocus(true);
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        // The window losing focus blurs the row too, and gives focus back to it on return.
        if (next === null && !event.currentTarget.ownerDocument.hasFocus()) away.current = focus;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocus(false);
      },
    },
  };
}

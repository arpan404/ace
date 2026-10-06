import { Suspense, useEffect, useRef } from "react";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import type { MenuPopupProps } from "./deferred-menu-button.tsx";

/** The real menu receives a cold button's press through the same Base UI event handlers. */
export function SidebarMenuPopup(props: MenuPopupProps) {
  const button = useRef<HTMLButtonElement>(null);
  const replayed = useRef<string>(undefined);
  useEffect(() => {
    let live = true;
    // Let the menu finish installing its effects, including Strict Mode's cleanup/restart,
    // before sending input. Replaying during that restart can lose the keyboard selection.
    queueMicrotask(() => {
      if (!live || !props.activation || !button.current || replayed.current === props.activation)
        return;
      replayed.current = props.activation;
      button.current.focus();
      button.current.dispatchEvent(
        ["click", "Enter", " "].includes(props.activation)
          ? new MouseEvent("click", {
              bubbles: true,
              cancelable: true,
              button: 0,
              detail: props.activation === "click" ? 1 : 0,
            })
          : new KeyboardEvent("keydown", {
              bubbles: true,
              cancelable: true,
              key: props.activation,
            }),
      );
    });
    return () => {
      live = false;
    };
  }, [props.activation]);
  const trigger = <MenuTrigger ref={button} render={props.trigger} />;
  return (
    <Menu>
      {props.tip ? (
        <Tip label={props.tip} side="right">
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
      <Suspense fallback={null}>{props.children}</Suspense>
    </Menu>
  );
}

/** A header's items need a content wrapper; sidebar slices provide their own content. */
export function HeaderMenuPopup(props: MenuPopupProps) {
  return (
    <SidebarMenuPopup {...props}>
      <MenuContent align={props.align}>{props.children}</MenuContent>
    </SidebarMenuPopup>
  );
}

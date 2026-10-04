import { Suspense, type ReactElement, type ReactNode } from "react";
import { Menu, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

/**
 * One of the sidebar's menus: its trigger from the start; its contents (`children`, a lazy
 * component holding the `MenuContent`) a moment after the first paint, so their items, icons
 * and wording stay out of the initial bundle. They start loading as the trigger first renders.
 */
export function SidebarMenu(props: {
  trigger: ReactElement;
  /** As an icon, the trigger's tooltip. */
  tip?: string | undefined;
  children: ReactNode;
}) {
  const trigger = <MenuTrigger render={props.trigger} />;
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

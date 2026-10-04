import { lazy, Suspense, type ReactElement } from "react";
import { Menu, MenuTrigger } from "@/components/ui/menu.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";

/** The menus' contents (their items, icons and wording) stay out of the first paint. */
const contents = {
  more: lazy(() =>
    import("./sidebar-menus.tsx").then((module) => ({ default: module.MoreMenuContent })),
  ),
  account: lazy(() =>
    import("./sidebar-menus.tsx").then((module) => ({ default: module.AccountMenuContent })),
  ),
};

/**
 * One of the sidebar's menus: its trigger from the start, its contents a moment after the
 * first paint (they start loading as the trigger first renders).
 */
export function SidebarMenu(props: {
  menu: keyof typeof contents;
  trigger: ReactElement;
  /** The sidebar is a column of icons: the menu opens beside it. */
  compact: boolean;
  /** As an icon, the trigger's tooltip. */
  tip?: string | undefined;
}) {
  const Content = contents[props.menu];
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
      <Suspense fallback={null}>
        <Content compact={props.compact} />
      </Suspense>
    </Menu>
  );
}

import { DotsThreeIcon } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Menu, MenuContent, MenuTrigger } from "@/components/ui/menu.tsx";

/** A 28px strip button, matching the dock's own controls beside it. */
export function ToolbarButton(props: Omit<ComponentProps<typeof IconButton>, "size">) {
  return <IconButton size="sm" {...props} className="size-7" />;
}

/** The ⋯ menu at the end of a tool's strip buttons. */
export function MoreMenu(props: { label: string; children: ReactNode }) {
  return (
    <Menu>
      <MenuTrigger render={<ToolbarButton icon={DotsThreeIcon} label={props.label} />} />
      <MenuContent align="end">{props.children}</MenuContent>
    </Menu>
  );
}

import { SidebarSimpleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";

/**
 * The rail and the sidebar on a narrow window: a sheet over the content, opened from the
 * header. It covers the header's toggle, so it carries its own at the end of the top row.
 */
export function SidebarSheet(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  rail: ReactNode;
  children: ReactNode;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-[min(344px,92vw)] flex-row gap-0 bg-[rgb(var(--sidebar-rgb))] p-0"
        // Following any link in it is a choice of where to go, even the page already open.
        onClickCapture={(event) => {
          const link = (event.target as Element).closest("a[href]");
          if (link && !event.defaultPrevented && !event.metaKey && !event.ctrlKey)
            props.onOpenChange(false);
        }}
      >
        <SheetTitle className="sr-only">Sidebar</SheetTitle>
        {props.rail}
        <div className="flex min-w-0 flex-1 flex-col">{props.children}</div>
        <IconButton
          icon={SidebarSimpleIcon}
          label="Hide sidebar"
          shortcut="toggleSidebar"
          onClick={() => props.onOpenChange(false)}
          className="absolute top-2.5 right-2.5 [-webkit-app-region:no-drag]"
        />
      </SheetContent>
    </Sheet>
  );
}

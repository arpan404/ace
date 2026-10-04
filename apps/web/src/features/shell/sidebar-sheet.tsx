import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet.tsx";

/** A view's second sidebar on a narrow window: a sheet over the content, opened from the header. */
export function SidebarSheet(props: {
  label: string;
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactNode;
}) {
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-[min(320px,85vw)] gap-0 bg-[rgb(var(--sidebar-rgb))] p-0"
      >
        <SheetTitle className="sr-only">{props.label}</SheetTitle>
        <aside aria-label={props.label} className="flex min-h-0 flex-1 flex-col">
          {props.children}
        </aside>
      </SheetContent>
    </Sheet>
  );
}

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@/lib/cn.ts";
import { popupSurface } from "./menu-styles.ts";

/**
 * Right-click menu. Items, separators, labels and submenus are the Menu parts from
 * `menu.tsx`, which Base UI shares between both roots.
 */
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="isolate z-[110] outline-none">
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(popupSurface, "min-w-[220px]", className)}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent };

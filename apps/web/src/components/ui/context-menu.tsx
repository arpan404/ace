import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { cn } from "@/lib/cn.ts";
import { layers, popupSurface } from "./menu-styles.ts";

/**
 * Right-click menu. Items, separators, labels and submenus are the Menu parts from
 * `menu.tsx`, which Base UI shares between both roots.
 */
const ContextMenu = ContextMenuPrimitive.Root;
const ContextMenuTrigger = ContextMenuPrimitive.Trigger;

function ContextMenuContent({ className, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner
        className={cn(layers.popup, "isolate outline-none [-webkit-app-region:no-drag]")}
      >
        <ContextMenuPrimitive.Popup
          data-slot="context-menu-content"
          className={cn(popupSurface, "min-w-[220px]", className)}
          finalFocus={() => !document.querySelector('[role="dialog"], [data-inline-rename]')}
          {...props}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent };

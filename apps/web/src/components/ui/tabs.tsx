import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/cn.ts";

const Tabs = TabsPrimitive.Root;

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex items-center gap-0.5", className)}
      {...props}
    />
  );
}

/**
 * Panel tab (Changes, Preview, Agents, Terminal, Logs): 12.5/500, 8% ink when active. Hover is
 * mostly a text change, so a hovered tab never reads as a second selected one.
 */
function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "relative inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] duration-(--dur-1) focus-ring touch-hit focus-visible:text-foreground",
        "hover:text-foreground hover:not-data-active:bg-foreground/3 data-active:bg-foreground/8 data-active:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-panel"
      className={cn("min-h-0 flex-1 focus-ring-inset", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanel };

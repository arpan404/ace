import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "cn";

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

/** Panel tab (Changes, Preview, Agents, Terminal, Logs): 12.5/500, 8% ink when active. */
function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground outline-none transition-colors duration-150",
        "hover:bg-accent hover:text-foreground data-active:bg-[color-mix(in_oklab,var(--foreground)_8%,transparent)] data-active:text-foreground",
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
      className={cn("min-h-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTab, TabsPanel };

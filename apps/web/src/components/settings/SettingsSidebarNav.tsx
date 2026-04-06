import { ArrowLeftIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "../ui/sidebar";
import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS } from "./settingsNavigation";

export {
  type SettingsSectionPath,
  SETTINGS_NAV_ITEMS,
  getSettingsNavItem,
} from "./settingsNavigation";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();

  return (
    <>
      <SidebarContent className="gap-0 overflow-x-hidden">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-2 py-2">
              <SidebarGroupLabel className="h-auto px-2 py-1 text-[10px] font-semibold tracking-[0.2em] text-muted-foreground/40 uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        isActive={isActive}
                        className={cn(
                          "h-auto min-h-12 items-start gap-2.5 rounded-xl px-2.5 py-2 text-left transition-all duration-200 ease-out",
                          isActive
                            ? "bg-primary/[0.06] text-foreground shadow-xs shadow-primary/[0.03]"
                            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                        )}
                        onClick={() => void navigate({ to: item.to, replace: true })}
                      >
                        <Icon
                          className={cn(
                            "mt-0.5 size-4 shrink-0 transition-colors duration-200",
                            isActive ? "text-primary/75" : "text-muted-foreground/50",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{item.label}</span>
                          <span
                            className={cn(
                              "mt-0.5 block truncate text-[11px] leading-4",
                              isActive ? "text-foreground/50" : "text-muted-foreground/50",
                            )}
                          >
                            {item.description}
                          </span>
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground/60 transition-all duration-200 ease-out hover:bg-foreground/[0.04] hover:text-foreground"
              onClick={() => window.history.back()}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

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
      <SidebarContent className="gap-0 overflow-x-hidden pt-1.5" scrollFade={false}>
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-2.5 py-1">
              <SidebarGroupLabel className="h-auto px-2 py-1 text-[10px] font-medium tracking-[0.14em] text-muted-foreground/45 uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-0.5">
                {items.map((item) => {
                  const Icon = item.icon;
                  const isActive = pathname === item.to;
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        title={item.description}
                        aria-label={`${item.label}: ${item.description}`}
                        isActive={isActive}
                        className={cn(
                          "h-8 items-center gap-2 rounded-[var(--control-radius)] px-2.5 text-left text-[13px] transition-colors duration-150 ease-out",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/72 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground",
                        )}
                        onClick={() => void navigate({ to: item.to, replace: true })}
                      >
                        <Icon
                          className={cn(
                            "size-3.5 shrink-0 transition-colors duration-150",
                            isActive
                              ? "text-sidebar-accent-foreground"
                              : "text-sidebar-foreground/45",
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/60 p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 rounded-[var(--control-radius)] px-2.5 text-[13px] font-medium text-sidebar-foreground/62 transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              onClick={() => window.history.back()}
            >
              <ArrowLeftIcon className="size-3.5" />
              <span>Back to chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

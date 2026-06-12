import { ArrowLeftIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  isSettingsNavItemActive,
} from "./settingsNavigation";
import {
  SETTINGS_SIDEBAR_BACK_CLASS,
  SETTINGS_SIDEBAR_GROUP_LABEL_CLASS,
  SETTINGS_SIDEBAR_ITEM_CLASS,
} from "./settingsUi";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();

  return (
    <>
      <SidebarContent className="gap-0 px-2 pb-3 pt-2" scrollFade={false}>
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-0 py-2.5 first:pt-0">
              <SidebarGroupLabel className={SETTINGS_SIDEBAR_GROUP_LABEL_CLASS}>
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-px">
                {items.map((item) => {
                  const isActive = isSettingsNavItemActive(pathname, item);
                  return (
                    <SidebarMenuItem key={item.to}>
                      <SidebarMenuButton
                        size="sm"
                        aria-label={`${item.label} settings`}
                        aria-current={isActive ? "page" : undefined}
                        isActive={isActive}
                        className={cn(SETTINGS_SIDEBAR_ITEM_CLASS)}
                        onClick={() => void navigate({ to: item.to })}
                      >
                        <span className="truncate">{item.label}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/40 p-2">
        <Button
          type="button"
          variant="ghost"
          className={SETTINGS_SIDEBAR_BACK_CLASS}
          onClick={() => void navigate({ to: "/", replace: true })}
        >
          <ArrowLeftIcon className="size-3.5 shrink-0 opacity-60" strokeWidth={2} />
          <span>Back to app</span>
        </Button>
      </SidebarFooter>
    </>
  );
}

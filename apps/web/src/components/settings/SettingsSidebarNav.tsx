import {
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  CircleHelpIcon,
  CodeXmlIcon,
  Globe2Icon,
  MessageCircleIcon,
  MonitorSmartphoneIcon,
  Settings2Icon,
  SlidersHorizontalIcon,
  WorkflowIcon,
  type LucideIcon,
} from "lucide-react";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_NAV_ITEMS,
  isSettingsNavItemActive,
} from "./settingsNavigation";
import type { SettingsSectionPath } from "./settingsNavigation";

const SETTINGS_NAV_ICON_BY_PATH = {
  "/settings/general": Settings2Icon,
  "/settings/browser": Globe2Icon,
  "/settings/chat": MessageCircleIcon,
  "/settings/editor": CodeXmlIcon,
  "/settings/environment": WorkflowIcon,
  "/settings/providers": BotIcon,
  "/settings/devices": MonitorSmartphoneIcon,
  "/settings/advanced": SlidersHorizontalIcon,
  "/settings/about": CircleHelpIcon,
  "/settings/archived": ArchiveIcon,
} satisfies Record<SettingsSectionPath, LucideIcon>;

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();

  return (
    <>
      <SidebarContent className="gap-0 overflow-x-hidden px-2.5 pt-2.5" scrollFade={false}>
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-0 pt-4 pb-0">
              <SidebarGroupLabel className="mb-1 h-5 px-1 py-0 text-[10px] font-semibold tracking-[0.16em] text-sidebar-foreground/38 uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-0">
                {items.map((item) => {
                  const isActive = isSettingsNavItemActive(pathname, item);
                  const Icon = SETTINGS_NAV_ICON_BY_PATH[item.to];
                  return (
                    <SidebarMenuItem key={item.to}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <SidebarMenuButton
                              size="sm"
                              aria-label={`${item.label} settings`}
                              isActive={isActive}
                              className={cn(
                                "group/settings-nav relative h-8 items-center gap-2 rounded-lg border-0 px-2 text-left transition-colors duration-150 ease-out",
                                isActive
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                  : "bg-transparent text-sidebar-foreground/62 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground",
                              )}
                              onClick={() => void navigate({ to: item.to })}
                            >
                              <span
                                className={cn(
                                  "inline-flex size-5 shrink-0 items-center justify-center transition-colors duration-150",
                                  isActive
                                    ? "text-sidebar-accent-foreground"
                                    : "text-sidebar-foreground/46 group-hover/settings-nav:text-sidebar-foreground/74",
                                )}
                              >
                                <Icon className="size-3.5 shrink-0" strokeWidth={2.05} />
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12.5px] leading-none font-medium">
                                {item.label}
                              </span>
                            </SidebarMenuButton>
                          }
                        />
                        <TooltipPopup side="right" className="max-w-72 whitespace-pre-wrap">
                          {item.description}
                        </TooltipPopup>
                      </Tooltip>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/60 p-2.5">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="h-8 gap-2 rounded-lg bg-transparent px-2 text-[12.5px] font-medium text-sidebar-foreground/64 transition-colors duration-150 ease-out hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground"
              onClick={() => void navigate({ to: "/", replace: true })}
            >
              <ArrowLeftIcon className="size-4" strokeWidth={2.15} />
              <span>Back to chat</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

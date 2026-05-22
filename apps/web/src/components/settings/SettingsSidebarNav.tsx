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
import { SETTINGS_NAV_GROUPS, SETTINGS_NAV_ITEMS } from "./settingsNavigation";
import type { SettingsSectionPath } from "./settingsNavigation";

const SETTINGS_NAV_ICON_BY_PATH = {
  "/settings/general": Settings2Icon,
  "/settings/browser": Globe2Icon,
  "/settings/chat": MessageCircleIcon,
  "/settings/editor": CodeXmlIcon,
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
      <SidebarContent className="gap-0 overflow-x-hidden pt-1.5" scrollFade={false}>
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-2.5 pt-5 pb-2">
              <SidebarGroupLabel className="mb-1.5 h-5 px-2 py-0 text-xs font-medium tracking-wider text-muted-foreground uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-0.5">
                {items.map((item) => {
                  const isActive = pathname === item.to;
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
                                "relative h-8 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors duration-150 ease-out",
                                isActive
                                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                              )}
                              onClick={() => void navigate({ to: item.to })}
                            >
                              <Icon className="size-4 shrink-0" strokeWidth={2.05} />
                              <span className="min-w-0 flex-1 truncate">{item.label}</span>
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
              className="h-8 gap-2 rounded-lg px-2.5 text-[13px] font-medium text-sidebar-foreground/70 transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground"
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

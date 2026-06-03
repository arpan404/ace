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
      <SidebarContent className="gap-0 overflow-x-hidden px-2 pt-2" scrollFade={false}>
        <div className="mx-0.5 mb-2 rounded-lg border border-sidebar-border/70 bg-sidebar-accent/38 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-sidebar-border/70 bg-sidebar text-sidebar-foreground/78">
              <Settings2Icon className="size-4" strokeWidth={2.1} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[12.5px] leading-snug font-semibold text-sidebar-foreground">
                Control center
              </p>
              <p className="truncate text-[11px] leading-snug text-sidebar-foreground/50">
                {SETTINGS_NAV_ITEMS.length} settings areas
              </p>
            </div>
          </div>
        </div>
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
          return (
            <SidebarGroup key={group.id} className="px-0 pt-3 pb-1">
              <SidebarGroupLabel className="mb-1.5 h-5 px-2 py-0 text-[10.5px] font-semibold tracking-[0.16em] text-sidebar-foreground/42 uppercase">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-1">
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
                                "group/settings-nav relative h-auto min-h-10 items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-[background-color,border-color,color,box-shadow] duration-150 ease-out",
                                isActive
                                  ? "border-sidebar-border/80 bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_0_1px_0_color-mix(in_srgb,currentColor_7%,transparent)]"
                                  : "border-transparent text-sidebar-foreground/68 hover:border-sidebar-border/55 hover:bg-sidebar-accent/55 hover:text-sidebar-accent-foreground",
                              )}
                              onClick={() => void navigate({ to: item.to })}
                            >
                              <span
                                className={cn(
                                  "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md border transition-colors duration-150",
                                  isActive
                                    ? "border-primary/25 bg-primary/12 text-primary"
                                    : "border-sidebar-border/60 bg-sidebar/55 text-sidebar-foreground/56 group-hover/settings-nav:text-sidebar-foreground/82",
                                )}
                              >
                                <Icon className="size-3.5 shrink-0" strokeWidth={2.15} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[12.5px] leading-snug font-semibold">
                                  {item.label}
                                </span>
                                <span className="mt-0.5 block truncate text-[10.5px] leading-snug font-medium text-sidebar-foreground/45 group-hover/settings-nav:text-sidebar-foreground/58">
                                  {item.description}
                                </span>
                              </span>
                              {isActive ? (
                                <span
                                  className="absolute top-2.5 right-2 h-2 w-2 rounded-full bg-primary/80"
                                  aria-hidden="true"
                                />
                              ) : null}
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
              className="h-9 gap-2 rounded-lg border border-sidebar-border/55 bg-sidebar-accent/28 px-2.5 text-[12.5px] font-semibold text-sidebar-foreground/76 transition-colors duration-150 ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:bg-sidebar-accent active:text-sidebar-accent-foreground"
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

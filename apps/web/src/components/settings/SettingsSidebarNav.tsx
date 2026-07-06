import { IconArrowBackUp, IconArrowLeft, IconSearch, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

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
  type SettingsSectionPath,
  isSettingsNavItemActive,
} from "./settingsNavigation";
import { searchSettings } from "./settingsSearch";
import { SETTINGS_RESTORED_EVENT } from "./settingsPageContext";
import {
  SETTINGS_SIDEBAR_BACK_CLASS,
  SETTINGS_SIDEBAR_GROUP_LABEL_CLASS,
  SETTINGS_SIDEBAR_ITEM_CLASS,
} from "./settingsUi";
import { useSettingsRestore } from "./useSettingsRestore";

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();
  const searchResults = trimmedQuery ? searchSettings(query) : [];
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    window.dispatchEvent(new Event(SETTINGS_RESTORED_EVENT)),
  );

  const goTo = (to: SettingsSectionPath) => {
    void navigate({ to });
    setQuery("");
  };

  return (
    <>
      <div className="flex flex-col gap-2 px-2 pb-1.5 pt-2">
        <Button
          type="button"
          variant="ghost"
          className={SETTINGS_SIDEBAR_BACK_CLASS}
          onClick={() => void navigate({ to: "/", replace: true })}
        >
          <IconArrowLeft className="size-4 shrink-0 opacity-60" stroke={2} />
          <span>Back to app</span>
        </Button>
        <div className="relative">
          <IconSearch
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/40"
            stroke={2}
            aria-hidden="true"
          />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            className="h-8 w-full rounded-[var(--control-radius)] border border-sidebar-border/60 bg-sidebar-accent/35 pl-8 pr-8 text-[13px] text-sidebar-foreground outline-none transition-colors placeholder:text-sidebar-foreground/40 focus-visible:border-ring/50 focus-visible:bg-sidebar-accent/55 focus-visible:ring-2 focus-visible:ring-ring/15"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-sidebar-foreground/45 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              <IconX className="size-3.5" stroke={2} />
            </button>
          ) : null}
        </div>
      </div>

      <SidebarContent className="gap-0 px-2 pb-3 pt-1" scrollFade={false}>
        {trimmedQuery ? (
          searchResults.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-sidebar-foreground/45">
              No settings match “{trimmedQuery}”.
            </p>
          ) : (
            <div className="flex flex-col gap-3 py-1">
              {searchResults.map((group) => {
                const Icon = group.item.icon;
                const rows =
                  group.matches.length > 0
                    ? group.matches.map((match) => match.title)
                    : [group.item.description];
                return (
                  <div key={group.item.to} className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => goTo(group.item.to)}
                      className="flex items-center gap-2 rounded-[var(--control-radius)] px-2 py-1 text-left text-[12px] font-medium text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground"
                    >
                      <Icon className="size-4 shrink-0 opacity-70" stroke={2} />
                      <span className="truncate">{group.item.label}</span>
                    </button>
                    {rows.map((row) => (
                      <button
                        key={row}
                        type="button"
                        onClick={() => goTo(group.item.to)}
                        className="truncate rounded-[var(--control-radius)] py-1 pl-8 pr-2 text-left text-[13px] text-sidebar-foreground/85 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                      >
                        {row}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          SETTINGS_NAV_GROUPS.map((group) => {
            const items = SETTINGS_NAV_ITEMS.filter((item) => item.group === group.id);
            if (items.length === 0) {
              return null;
            }
            return (
              <SidebarGroup key={group.id} className="px-0 py-2 first:pt-1">
                <SidebarGroupLabel className={SETTINGS_SIDEBAR_GROUP_LABEL_CLASS}>
                  {group.label}
                </SidebarGroupLabel>
                <SidebarMenu className="gap-px">
                  {items.map((item) => {
                    const isActive = isSettingsNavItemActive(pathname, item);
                    const Icon = item.icon;
                    return (
                      <SidebarMenuItem key={item.to}>
                        <SidebarMenuButton
                          size="sm"
                          aria-label={`${item.label} settings`}
                          aria-current={isActive ? "page" : undefined}
                          isActive={isActive}
                          className={cn(SETTINGS_SIDEBAR_ITEM_CLASS, "h-8 gap-2.5")}
                          onClick={() => void navigate({ to: item.to })}
                        >
                          <Icon
                            className={cn(
                              "size-[18px] shrink-0 transition-colors",
                              isActive ? "opacity-95" : "opacity-55",
                            )}
                            stroke={2}
                          />
                          <span className="truncate">{item.label}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            );
          })
        )}
      </SidebarContent>

      {changedSettingLabels.length > 0 ? (
        <SidebarFooter className="border-t border-sidebar-border/40 p-2">
          <Button
            type="button"
            variant="ghost"
            className={cn(SETTINGS_SIDEBAR_BACK_CLASS, "text-sidebar-foreground/70")}
            onClick={() => void restoreDefaults()}
          >
            <IconArrowBackUp className="size-4 shrink-0 opacity-70" stroke={2} />
            <span>Reset {changedSettingLabels.length} changed</span>
          </Button>
        </SidebarFooter>
      ) : null}
    </>
  );
}

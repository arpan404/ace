import { SlashIcon } from "@/components/slash-icon.tsx";
import { useSkillDiscovery } from "./discovered-skills.tsx";
import {
  FunnelSimpleIcon,
  ClockIcon,
  PlugIcon,
  RobotIcon,
  ScrollIcon,
  SparkleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Popover, PopoverContent, PopoverTrigger, PopoverTitle } from "@/components/ui/popover.tsx";
import { Select } from "@/components/ui/select.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import {
  useViewListKeys,
  CompactViewRowBody,
  compactViewRowClass,
  ViewSidebarError,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { InstallPluginButton } from "./install-plugin.tsx";
import { useRemovalReconciler } from "./remove-plugin.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { catalogSourceLabel } from "@/lib/catalog.ts";
import { skillTitle } from "./skills-model.ts";
import type { Skill, SkillKind } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";
import { Disclosure } from "@/components/ui/disclosure.tsx";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: SparkleIcon },
  { kind: "command", label: "Slash commands", icon: SlashIcon },
  { kind: "agent", label: "Agents", icon: RobotIcon },
  { kind: "rule", label: "Rules", icon: ScrollIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
  { kind: "mcp-tool", label: "Tools", icon: WrenchIcon },
  { kind: "workflow", label: "Workflows", icon: ClockIcon },
];

/** The catalog as the sidebar draws it: grouped by kind, in catalog order within a kind. */
export function catalogOrder(skills: readonly Skill[]): Skill[] {
  return kinds.flatMap((group) => skills.filter((skill) => skill.kind === group.kind));
}

/** Name, description or the plugin it ships with: "engineering" finds all it ships. */
function matches(skill: Skill, query: string): boolean {
  const text = query.trim().toLowerCase();
  return (
    !text ||
    skill.name.toLowerCase().includes(text) ||
    skillTitle(skill).toLowerCase().includes(text) ||
    skill.description.toLowerCase().includes(text) ||
    skill.plugin.toLowerCase().includes(text)
  );
}

/** Skills' list in the sidebar: what installed plugins ship, searchable and by plugin. */
export function SkillsSidebar() {
  const skills = useSkills();
  const discovery = useSkillDiscovery();
  useRemovalReconciler();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<SkillKind>>(new Set(["skill"]));
  const [kind, setKind] = useState("all");
  const [plugin, setPlugin] = useState("all");
  const listKeys = useViewListKeys<HTMLElement>();
  const plugins = (skills.data ?? []).filter((skill) => skill.kind === "plugin");
  const shown = (skills.data ?? []).filter(
    (skill) =>
      (kind === "all" || skill.kind === kind) &&
      (plugin === "all" || skill.plugin === plugin) &&
      matches(skill, query),
  );
  const groups = kinds
    .map((group) => ({ group, members: shown.filter((skill) => skill.kind === group.kind) }))
    .filter((group) => group.members.length);
  return (
    <ViewSidebar
      actions={
        <>
          <Popover>
            <PopoverTrigger render={<IconButton icon={FunnelSimpleIcon} label="Filter skills" />} />
            <PopoverContent align="end" className="flex w-64 flex-col gap-3">
              <PopoverTitle className="text-sm font-medium">Filter skills</PopoverTitle>
              <Select
                label="Plugin"
                value={plugin}
                options={[
                  { value: "all", label: "All plugins" },
                  ...plugins.map((entry) => ({ value: entry.plugin, label: entry.name })),
                ]}
                onValueChange={setPlugin}
                className="w-full"
              />
              <Select
                label="Kind"
                value={kind}
                options={[
                  { value: "all", label: "All kinds" },
                  ...kinds.map((group) => ({ value: group.kind, label: group.label })),
                ]}
                onValueChange={setKind}
              />
              {discovery.controls}
            </PopoverContent>
          </Popover>
          {!!skills.data?.length && <InstallPluginButton />}
        </>
      }
      toolbar={
        <div className="shrink-0 pr-2.5 pb-2 pl-3">
          <SearchField
            label="Search skills"
            placeholder="Search skills"
            value={query}
            onValueChange={setQuery}
            className="bg-sidebar-accent"
          />
        </div>
      }
    >
      {skills.isError ? (
        <ViewSidebarError onRetry={() => void skills.refetch()} />
      ) : !skills.data ? (
        <ListSkeleton label="skills" shape="row" rows={5} />
      ) : !skills.data.length ? null : !shown.length ? (
        <EmptyState
          variant="inline"
          title="No matching skills"
          description={query.trim() ? `Nothing matches "${query.trim()}".` : undefined}
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setQuery("");
                setPlugin("all");
                setKind("all");
              }}
            >
              Clear search
            </Button>
          }
        />
      ) : (
        <nav aria-label="Skills catalog" {...listKeys}>
          {groups.map(({ group, members }) => {
            const expandedNow = !!query.trim() || kind !== "all" || expanded.has(group.kind);
            const rows = members.map((skill) => (
              <li key={skill.id}>
                <Link
                  to="/skills/$skillId"
                  params={{ skillId: skill.id }}
                  aria-label={
                    skill.discovered
                      ? [
                          skillTitle(skill),
                          catalogSourceLabel(skill.discovered),
                          !skill.enabled && "Off",
                        ]
                          .filter(Boolean)
                          .join(" ")
                      : undefined
                  }
                  className={compactViewRowClass}
                >
                  <CompactViewRowBody
                    icon={group.icon}
                    title={skillTitle(skill)}
                    status={!skill.enabled ? <StatusLabel tone="idle" label="Off" /> : undefined}
                  />
                </Link>
              </li>
            ));
            // One kind needs no label: the view's title already names the list.
            return groups.length > 1 ? (
              <Disclosure
                key={group.kind}
                open={expandedNow}
                className="my-2"
                summaryClassName="w-full rounded-md px-3 py-2"
                summary={`${group.label} · ${members.length}`}
                onClick={(event) => {
                  // Only the summary toggles; the open state is owned here, not by the browser.
                  const summary =
                    event.target instanceof Element ? event.target.closest("summary") : null;
                  if (summary?.parentElement !== event.currentTarget) return;
                  event.preventDefault();
                  setExpanded((before) => {
                    const next = new Set(before);
                    if (next.has(group.kind)) next.delete(group.kind);
                    else next.add(group.kind);
                    return next;
                  });
                }}
              >
                <ul hidden={!expandedNow} aria-label={group.label}>
                  {rows}
                </ul>
              </Disclosure>
            ) : (
              <ul key={group.kind} className="mt-1 flex flex-col gap-px">
                {rows}
              </ul>
            );
          })}
        </nav>
      )}
    </ViewSidebar>
  );
}

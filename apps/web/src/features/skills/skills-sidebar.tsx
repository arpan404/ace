import { CommandIcon, PlugIcon, RobotIcon, ScrollIcon, SparkleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import {
  useViewListKeys,
  CompactViewRowBody,
  ViewRowSection,
  compactViewRowClass,
  ViewSidebarError,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { InstallPluginButton } from "./install-plugin.tsx";
import { useRemovalReconciler } from "./remove-plugin.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { skillTitle } from "./skills-model.ts";
import type { Skill, SkillKind } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: SparkleIcon },
  { kind: "command", label: "Slash commands", icon: CommandIcon },
  { kind: "agent", label: "Agents", icon: RobotIcon },
  { kind: "rule", label: "Rules", icon: ScrollIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
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
  useRemovalReconciler();
  const [query, setQuery] = useState("");
  const [plugin, setPlugin] = useState("all");
  const listKeys = useViewListKeys<HTMLElement>();
  const plugins = (skills.data ?? []).filter((skill) => skill.kind === "plugin");
  const shown = (skills.data ?? []).filter(
    (skill) => (plugin === "all" || skill.plugin === plugin) && matches(skill, query),
  );
  const groups = kinds
    .map((group) => ({ group, members: shown.filter((skill) => skill.kind === group.kind) }))
    .filter((group) => group.members.length);
  return (
    <ViewSidebar
      title="Skills"
      actions={
        skills.data?.length ? (
          <>
            <FilterMenu
              label="Plugin"
              value={plugin}
              options={[
                { value: "all", label: "All plugins" },
                ...plugins.map((entry) => ({ value: entry.plugin, label: entry.name })),
              ]}
              onValueChange={setPlugin}
            />
            <InstallPluginButton />
          </>
        ) : undefined
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
              }}
            >
              Clear search
            </Button>
          }
        />
      ) : (
        <nav aria-label="Skills catalog" {...listKeys}>
          {groups.map(({ group, members }) => {
            const rows = members.map((skill) => (
              <li key={skill.id}>
                <Link
                  to="/skills/$skillId"
                  params={{ skillId: skill.id }}
                  className={compactViewRowClass}
                >
                  <CompactViewRowBody
                    icon={group.icon}
                    title={skillTitle(skill)}
                    status={skill.enabled ? undefined : <StatusLabel tone="idle" label="Off" />}
                  />
                </Link>
              </li>
            ));
            // One kind needs no label: the view's title already names the list.
            return groups.length > 1 ? (
              <ViewRowSection key={group.kind} label={group.label}>
                {rows}
              </ViewRowSection>
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

import {
  CommandIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  RobotIcon,
  ScrollIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import {
  ViewRowBody,
  ViewRowSection,
  viewRowClass,
  ViewSidebarError,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { InstallPlugin } from "./install-plugin.tsx";
import type { Skill, SkillKind } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: SparkleIcon },
  { kind: "command", label: "Slash commands", icon: CommandIcon },
  { kind: "agent", label: "Agents", icon: RobotIcon },
  { kind: "rule", label: "Rules", icon: ScrollIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
];

function matches(skill: Skill, query: string): boolean {
  const text = query.trim().toLowerCase();
  return (
    !text ||
    skill.name.toLowerCase().includes(text) ||
    skill.description.toLowerCase().includes(text)
  );
}

/** Skills' second sidebar: what installed plugins ship, searchable and by plugin. */
export function SkillsSidebar() {
  const skills = useSkills();
  const [query, setQuery] = useState("");
  const [plugin, setPlugin] = useState("all");
  const plugins = (skills.data ?? []).filter((skill) => skill.kind === "plugin");
  const shown = (skills.data ?? []).filter(
    (skill) => (plugin === "all" || skill.plugin === plugin) && matches(skill, query),
  );
  return (
    <ViewSidebar
      title="Skills"
      actions={
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
          <InstallPlugin />
        </>
      }
      toolbar={
        <div className="shrink-0 pr-2.5 pb-2 pl-3">
          <label className="flex h-8 w-full items-center gap-2 rounded-[9px] bg-sidebar-accent pr-2 pl-2.5 text-ui text-subtle-foreground focus-within:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]">
            <Icon icon={MagnifyingGlassIcon} />
            <input
              type="search"
              aria-label="Search skills"
              placeholder="Search skills"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-subtle-foreground"
            />
          </label>
        </div>
      }
    >
      {skills.isError ? (
        <ViewSidebarError onRetry={() => void skills.refetch()} />
      ) : !skills.data ? (
        <ListSkeleton label="skills" shape="tile" rows={5} />
      ) : !shown.length ? (
        <EmptyState
          icon={CubeIcon}
          title={skills.data.length ? "No matching skills" : "No plugins yet"}
          description="Skills, commands, agents and rules from installed plugins appear here."
        />
      ) : (
        <nav aria-label="Skills catalog">
          {kinds.map((group) => {
            const members = shown.filter((skill) => skill.kind === group.kind);
            return members.length ? (
              <ViewRowSection key={group.kind} label={group.label}>
                {members.map((skill) => (
                  <li key={skill.id}>
                    <Link
                      to="/skills/$skillId"
                      params={{ skillId: skill.id }}
                      className={viewRowClass}
                    >
                      <ViewRowBody
                        icon={group.icon}
                        title={skill.name}
                        description={skill.description}
                        meta={skill.enabled ? undefined : "off"}
                      />
                    </Link>
                  </li>
                ))}
              </ViewRowSection>
            ) : null;
          })}
        </nav>
      )}
    </ViewSidebar>
  );
}

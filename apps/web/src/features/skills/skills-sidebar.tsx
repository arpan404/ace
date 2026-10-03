import {
  CommandIcon,
  CubeIcon,
  MagnifyingGlassIcon,
  PlugIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import { Icon } from "@/components/icon.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { ViewRowBody, ViewRowSection, viewRowClass } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/view-frame.tsx";
import { InstallPlugin } from "./install-plugin.tsx";
import { useSkills, type Skill, type SkillKind, type SkillSource } from "./skills-source.ts";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: SparkleIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
  { kind: "command", label: "Slash commands", icon: CommandIcon },
];

type SourceFilter = "all" | SkillSource;
const sources: readonly { value: SourceFilter; label: string }[] = [
  { value: "all", label: "All sources" },
  { value: "repo", label: "This repo" },
  { value: "user", label: "Your home folder" },
  { value: "plugin", label: "Plugins" },
];

function matches(skill: Skill, query: string): boolean {
  const text = query.trim().toLowerCase();
  return (
    !text ||
    skill.name.toLowerCase().includes(text) ||
    skill.description.toLowerCase().includes(text)
  );
}

/** Skills' second sidebar: skills, plugins and slash commands, searchable and by source. */
export function SkillsSidebar() {
  const skills = useSkills();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const shown = (skills.data ?? []).filter(
    (skill) => (source === "all" || skill.source === source) && matches(skill, query),
  );
  return (
    <ViewSidebar
      title="Skills"
      actions={
        <>
          <FilterMenu
            label="Source"
            value={source}
            options={sources}
            onValueChange={(value) => setSource(value)}
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
        <EmptyState icon={CubeIcon} title="Skills unavailable" description={skills.error.message} />
      ) : skills.data && !shown.length ? (
        <EmptyState
          icon={CubeIcon}
          title="No matching skills"
          description="Skills and commands your agents can use appear here."
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

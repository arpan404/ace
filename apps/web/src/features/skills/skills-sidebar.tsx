import {
  ClockIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
  PlugIcon,
  PlusIcon,
  RobotIcon,
  ScrollIcon,
  SparkleIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { SearchField } from "@/components/search-field.tsx";
import { SlashIcon } from "@/components/slash-icon.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Disclosure } from "@/components/ui/disclosure.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import {
  CompactViewRowBody,
  compactViewRowClass,
  useViewListKeys,
  ViewSidebarError,
} from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useSkillLibrary } from "./skills-library.tsx";
import { useInstallDialog } from "./install-plugin.tsx";
import { groupByHome, homeLabel, rowMarks, type SkillHome } from "./library-model.ts";
import { ProviderMarks } from "./provider-marks.tsx";
import { useRemovalReconciler } from "./remove-plugin.tsx";
import { skillTitle, type Skill, type SkillKind } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: SparkleIcon },
  { kind: "command", label: "Slash commands", icon: SlashIcon },
  { kind: "agent", label: "Agents", icon: RobotIcon },
  { kind: "rule", label: "Rules", icon: ScrollIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
  { kind: "mcp-tool", label: "Tools", icon: WrenchIcon },
  { kind: "workflow", label: "Workflows", icon: ClockIcon },
];

const kindIcon = (kind: SkillKind) =>
  kinds.find((entry) => entry.kind === kind)?.icon ?? SparkleIcon;

/** The library as the sidebar draws it: by where each skill lives, in list order within. */
export function catalogOrder(skills: readonly Skill[]): Skill[] {
  return groupByHome(skills).flatMap((group) => group.members);
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

/** Skills' list in the sidebar: every skill the person's agents can load, by where it lives. */
export function SkillsSidebar() {
  const skills = useSkills();
  const discovery = useSkillLibrary();
  useRemovalReconciler();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<SkillHome>>(new Set());
  const listKeys = useViewListKeys<HTMLElement>();
  const shown = (skills.data ?? []).filter((skill) => matches(skill, query));
  const groups = groupByHome(shown);
  const searching = !!query.trim();
  return (
    <ViewSidebar
      title="Skills"
      actions={
        <>
          {discovery.projects.length > 1 && discovery.project && <ProjectMenu />}
          <AddMenu />
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
          description={`Nothing matches "${query.trim()}".`}
          action={
            <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <nav aria-label="Skills catalog" {...listKeys}>
          {groups.map(({ home, members }) => {
            const open = searching || !collapsed.has(home);
            const label = homeLabel(home, discovery.project?.name);
            return (
              <Disclosure
                key={home}
                open={open}
                className="mt-1 mb-2"
                summaryClassName="w-full rounded-md px-3 py-2"
                summary={
                  <span>
                    {label} <span className="text-subtle-foreground">· {members.length}</span>
                  </span>
                }
                onClick={(event) => {
                  // Only the summary toggles; the open state is owned here, not by the browser.
                  const summary =
                    event.target instanceof Element ? event.target.closest("summary") : null;
                  if (summary?.parentElement !== event.currentTarget) return;
                  event.preventDefault();
                  setCollapsed((before) => {
                    const next = new Set(before);
                    if (next.has(home)) next.delete(home);
                    else next.add(home);
                    return next;
                  });
                }}
              >
                <ul hidden={!open} aria-label={label} className="flex flex-col gap-px">
                  {members.map((skill) => (
                    <li key={skill.id}>
                      <SkillRow skill={skill} />
                    </li>
                  ))}
                </ul>
              </Disclosure>
            );
          })}
        </nav>
      )}
    </ViewSidebar>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const marks = rowMarks(skill.providers);
  return (
    <Link to="/skills/$skillId" params={{ skillId: skill.id }} className={compactViewRowClass}>
      <CompactViewRowBody
        icon={kindIcon(skill.kind)}
        title={skillTitle(skill)}
        status={
          !skill.enabled ? (
            <StatusLabel tone="idle" label="Off" />
          ) : marks.length ? (
            <ProviderMarks providers={marks} size={12} />
          ) : undefined
        }
      />
    </Link>
  );
}

/** + : write a new skill, or install a plugin through its review. */
function AddMenu() {
  const navigate = useNavigate();
  const install = useInstallDialog();
  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={PlusIcon} label="Add a skill" />} />
      <MenuContent align="end">
        <MenuItem
          icon={<Icon icon={PencilSimpleIcon} />}
          onClick={() => void navigate({ to: "/skills/new" })}
        >
          New skill
        </MenuItem>
        <MenuItem icon={<Icon icon={PlugIcon} />} onClick={install.install}>
          Install a plugin…
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

/** Which project's skills are listed; only drawn when there is more than one to pick. */
function ProjectMenu() {
  const discovery = useSkillLibrary();
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={FolderSimpleIcon}
            label={`Project: ${discovery.project?.name ?? ""}`}
          />
        }
      />
      <MenuContent align="end">
        <MenuRadioGroup
          value={discovery.project?.id}
          onValueChange={(id: string) => discovery.chooseProject(id)}
        >
          {discovery.projects.map((project) => (
            <MenuRadioItem key={project.id} value={project.id}>
              {project.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

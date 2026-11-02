import {
  ClockIcon,
  FolderSimpleIcon,
  PencilSimpleIcon,
  PlugIcon,
  PlusIcon,
  RobotIcon,
  ScrollIcon,
  StackIcon,
  WrenchIcon,
} from "@phosphor-icons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";
import { SlashIcon } from "@/components/slash-icon.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
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
import { VirtualList, type VirtualRowsHandle } from "@/components/virtual-rows.tsx";
import { PanelDisclosure, PanelRowBody, panelRow, PanelSearch } from "@/components/ui/panel.tsx";
import { useViewListKeys, ViewSidebarError } from "@/components/ui/view-row.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useSkillLibrary } from "./skills-library.tsx";
import { useInstallDialog } from "./install-plugin.tsx";
import { groupByHome, homeLabel, rowMarks, type SkillHome } from "./library-model.ts";
import { ProviderMarks } from "./provider-marks.tsx";
import { useRemovalReconciler } from "./remove-plugin.tsx";
import { skillTitle, type Skill, type SkillKind } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

export const kinds: readonly { kind: SkillKind; label: string; icon: IconGlyph }[] = [
  { kind: "skill", label: "Skills", icon: StackIcon },
  { kind: "command", label: "Slash commands", icon: SlashIcon },
  { kind: "agent", label: "Agents", icon: RobotIcon },
  { kind: "rule", label: "Rules", icon: ScrollIcon },
  { kind: "plugin", label: "Plugins", icon: PlugIcon },
  { kind: "mcp-tool", label: "Tools", icon: WrenchIcon },
  { kind: "workflow", label: "Workflows", icon: ClockIcon },
];

const kindIcon = (kind: SkillKind) => kinds.find((entry) => entry.kind === kind)?.icon ?? StackIcon;

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

/** One row of the sidebar's list: a home's folding label, or a skill under it. */
type CatalogRow =
  | { kind: "home"; home: SkillHome; label: string; count: number; open: boolean; first: boolean }
  | { kind: "skill"; skill: Skill };

/** A label and a skill are each one `--row-height` line: the label with the gap above it, the skill with 1px below. */
const estimateOf = (row: CatalogRow) => (row.kind === "skill" ? 37 : row.first ? 40 : 56);

/**
 * Skills' list in the sidebar: every skill the person's agents can load, by where it lives. A
 * library can hold thousands, so the list is one flat run of labels and skills, mounted only near
 * the viewport.
 */
export function SkillsSidebar() {
  const skills = useSkills();
  const discovery = useSkillLibrary();
  useRemovalReconciler();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<SkillHome>>(new Set());
  const shown = (skills.data ?? []).filter((skill) => matches(skill, query));
  const searching = !!query.trim();
  const rows: CatalogRow[] = [];
  for (const { home, members } of groupByHome(shown)) {
    const open = searching || !collapsed.has(home);
    const label = homeLabel(home, discovery.project?.name);
    rows.push({ kind: "home", home, label, count: members.length, open, first: !rows.length });
    if (open) for (const skill of members) rows.push({ kind: "skill", skill });
  }
  const handle = useRef<VirtualRowsHandle>(null);
  const listKeys = useViewListKeys<HTMLElement>({
    count: rows.length,
    titleAt: (index) => {
      const row = rows[index];
      return row?.kind === "skill" ? skillTitle(row.skill) : undefined;
    },
    reveal: (index) => handle.current?.scrollToIndex(index, "auto"),
  });
  const toggle = (home: SkillHome) =>
    setCollapsed((before) => {
      const next = new Set(before);
      if (next.has(home)) next.delete(home);
      else next.add(home);
      return next;
    });
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
        <PanelSearch
          label="Search skills"
          placeholder="Search skills"
          value={query}
          onValueChange={setQuery}
        />
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
          <VirtualList
            label="Skills"
            items={rows}
            handle={handle}
            rowKey={(row) => (row.kind === "home" ? `home:${row.home}` : row.skill.id)}
            estimate={estimateOf}
            render={(row) =>
              row.kind === "home" ? (
                // A heading that folds its skills away, so the list still reads as groups.
                <h3 className={row.first ? "pt-1" : "pt-5"}>
                  <PanelDisclosure open={row.open} onClick={() => toggle(row.home)}>
                    <span className="min-w-0 flex-1 truncate">
                      {row.label} <span className="text-subtle-foreground">· {row.count}</span>
                    </span>
                  </PanelDisclosure>
                </h3>
              ) : (
                <div className="pb-px">
                  <SkillRow skill={row.skill} />
                </div>
              )
            }
          />
        </nav>
      )}
    </ViewSidebar>
  );
}

function SkillRow({ skill }: { skill: Skill }) {
  const marks = rowMarks(skill.providers);
  return (
    <Link to="/skills/$skillId" params={{ skillId: skill.id }} {...panelRow()}>
      <PanelRowBody
        icon={kindIcon(skill.kind)}
        title={skillTitle(skill)}
        trailing={
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
      <MenuTrigger render={<IconButton icon={PlusIcon} label="Add a skill" size="panel" />} />
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
            size="panel"
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

import {
  CaretDownIcon,
  FolderSimpleIcon,
  GitBranchIcon,
  TreeStructureIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { WorkMode } from "./choices.ts";

const modes: Record<WorkMode, { label: string; hint: string }> = {
  worktree: { label: "Worktree", hint: "A new branch in its own checkout" },
  local: { label: "Local", hint: "Work in the project checkout" },
};

/**
 * Under the composer: which project, a worktree or the local checkout, and the branch a
 * worktree starts from. Quiet text buttons separated by hairlines, like the thread's bar.
 */
export function ContextBar(props: {
  projects: readonly string[];
  project: string | undefined;
  onProject(project: string): void;
  mode: WorkMode;
  onMode(mode: WorkMode): void;
  branches: readonly string[];
  /** Undefined when the project's branches aren't known. */
  base: string | undefined;
  onBase(branch: string): void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pt-2 text-sm text-muted-foreground">
      <Picker
        icon={FolderSimpleIcon}
        name="Project"
        value={props.project ?? "Choose a project"}
        label="Projects"
        current={props.project ?? ""}
        options={props.projects.map((p) => ({ value: p, label: p }))}
        onChange={props.onProject}
      />
      <Divider />
      <Picker
        icon={TreeStructureIcon}
        name="Where the work happens"
        value={modes[props.mode].label}
        label="Work in"
        current={props.mode}
        options={WorkMode.options.map((m) => ({
          value: m,
          label: modes[m].label,
          hint: modes[m].hint,
        }))}
        onChange={(value) => {
          const parsed = WorkMode.safeParse(value);
          if (parsed.success) props.onMode(parsed.data);
        }}
      />
      {props.mode === "worktree" && props.base !== undefined && (
        <>
          <Divider />
          <Picker
            icon={GitBranchIcon}
            name="Start from branch"
            value={`from ${props.base}`}
            label="Start from"
            current={props.base}
            mono
            options={props.branches.map((b) => ({ value: b, label: b }))}
            onChange={props.onBase}
          />
        </>
      )}
    </div>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-3 w-px bg-border" />;
}

function Picker(props: {
  icon: PhosphorIcon;
  name: string;
  value: string;
  label: string;
  current: string;
  options: { value: string; label: string; hint?: string }[];
  onChange(value: string): void;
  mono?: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger
        aria-label={`${props.name}: ${props.value}`}
        className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] px-2 outline-none transition-colors duration-150 hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground"
      >
        <Icon icon={props.icon} size={14} />
        <span className={props.mono ? "font-mono text-[12px]" : undefined}>{props.value}</span>
        <CaretDownIcon aria-hidden size={12} />
      </MenuTrigger>
      <MenuContent side="top" className="max-h-[50vh] min-w-[220px] overflow-y-auto">
        <MenuGroup>
          <MenuLabel>{props.label}</MenuLabel>
          <MenuRadioGroup value={props.current} onValueChange={(v) => props.onChange(String(v))}>
            {props.options.map((option) => (
              <MenuRadioItem key={option.value} value={option.value} aria-label={option.label}>
                <span className="flex items-center gap-3">
                  <span className={props.mono ? "font-mono text-[12px]" : undefined}>
                    {option.label}
                  </span>
                  {option.hint && (
                    <span className="ml-auto text-xs text-subtle-foreground">{option.hint}</span>
                  )}
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

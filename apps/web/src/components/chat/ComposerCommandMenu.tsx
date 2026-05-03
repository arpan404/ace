import { type ProjectEntry, type ProviderKind } from "@ace/contracts";
import { IconStack2 } from "@tabler/icons-react";
import { memo, useLayoutEffect, useMemo, useRef } from "react";
import { type ComposerTriggerKind } from "../../composer-logic";
import { BotIcon, HashIcon, PlugIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Command, CommandGroup, CommandGroupLabel, CommandItem, CommandList } from "../ui/command";
import { VscodeEntryIcon } from "./VscodeEntryIcon";

export type ComposerCommandItem =
  | {
      id: string;
      type: "path";
      path: string;
      pathKind: ProjectEntry["kind"];
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "slash-command";
      command: string;
      commandSource: "ace";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "provider-command";
      command: string;
      commandKind: "skill" | "plugin";
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "model";
      provider: ProviderKind;
      model: string;
      label: string;
      description: string;
    }
  | {
      id: string;
      type: "issue";
      issueNumber: number;
      label: string;
      description: string;
    };

type ComposerCommandSectionId = "commands" | "skills" | "plugins" | "models" | "issues" | "files";

type ComposerCommandSection = {
  readonly id: ComposerCommandSectionId;
  readonly label: string | null;
  readonly items: ComposerCommandItem[];
};

const COMPOSER_COMMAND_SECTION_ORDER = [
  "commands",
  "skills",
  "plugins",
  "models",
  "issues",
  "files",
] as const satisfies ReadonlyArray<ComposerCommandSectionId>;

const COMPOSER_COMMAND_SECTION_LABELS = {
  commands: null,
  skills: "Skills",
  plugins: "Plugins",
  models: "Models",
  issues: "Issues",
  files: "Files",
} as const satisfies Record<ComposerCommandSectionId, string | null>;

function composerCommandSectionId(item: ComposerCommandItem): ComposerCommandSectionId {
  if (item.type === "provider-command") {
    return item.commandKind === "plugin" ? "plugins" : "skills";
  }
  if (item.type === "slash-command") {
    return "commands";
  }
  if (item.type === "model") {
    return "models";
  }
  if (item.type === "issue") {
    return "issues";
  }
  return "files";
}

function groupComposerCommandItems(
  items: ReadonlyArray<ComposerCommandItem>,
): ComposerCommandSection[] {
  const grouped = new Map<ComposerCommandSectionId, ComposerCommandItem[]>();
  for (const item of items) {
    const sectionId = composerCommandSectionId(item);
    const sectionItems = grouped.get(sectionId);
    if (sectionItems) {
      sectionItems.push(item);
    } else {
      grouped.set(sectionId, [item]);
    }
  }

  return COMPOSER_COMMAND_SECTION_ORDER.flatMap((id) => {
    const sectionItems = grouped.get(id);
    return sectionItems
      ? [
          {
            id,
            label: COMPOSER_COMMAND_SECTION_LABELS[id],
            items: sectionItems,
          },
        ]
      : [];
  });
}

export const ComposerCommandMenu = memo(function ComposerCommandMenu(props: {
  items: ComposerCommandItem[];
  resolvedTheme: "light" | "dark";
  isLoading: boolean;
  triggerKind: ComposerTriggerKind | null;
  activeItemId: string | null;
  onHighlightedItemChange: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const sections = useMemo(() => groupComposerCommandItems(props.items), [props.items]);

  useLayoutEffect(() => {
    if (!props.activeItemId || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-composer-item-id="${CSS.escape(props.activeItemId)}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [props.activeItemId]);

  return (
    <Command
      autoHighlight={false}
      mode="none"
      onItemHighlighted={(highlightedValue) => {
        props.onHighlightedItemChange(
          typeof highlightedValue === "string" ? highlightedValue : null,
        );
      }}
    >
      <div
        ref={listRef}
        className="relative overflow-hidden rounded-lg border border-border bg-popover"
      >
        <CommandList className="max-h-64">
          {sections.map((section) => (
            <CommandGroup key={section.id}>
              {section.label ? (
                <CommandGroupLabel className="px-2 pb-1 pt-2 font-medium text-muted-foreground/75 text-xs">
                  {section.label}
                </CommandGroupLabel>
              ) : null}
              {section.items.map((item) => (
                <ComposerCommandMenuItem
                  key={item.id}
                  item={item}
                  resolvedTheme={props.resolvedTheme}
                  isActive={props.activeItemId === item.id}
                  onHighlight={props.onHighlightedItemChange}
                  onSelect={props.onSelect}
                />
              ))}
            </CommandGroup>
          ))}
        </CommandList>
        {props.items.length === 0 && (
          <p className="px-3 py-2 text-muted-foreground/70 text-xs">
            {props.isLoading
              ? props.triggerKind === "issue"
                ? "Searching GitHub issues..."
                : "Searching workspace files..."
              : props.triggerKind === "path"
                ? "No matching files or folders."
                : props.triggerKind === "issue"
                  ? "No matching GitHub issues."
                  : "No matching skill or plugin command."}
          </p>
        )}
      </div>
    </Command>
  );
});

const ComposerCommandMenuItem = memo(function ComposerCommandMenuItem(props: {
  item: ComposerCommandItem;
  resolvedTheme: "light" | "dark";
  isActive: boolean;
  onHighlight: (itemId: string | null) => void;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  return (
    <CommandItem
      value={props.item.id}
      data-composer-item-id={props.item.id}
      className={cn(
        "cursor-pointer select-none gap-2 hover:bg-transparent hover:text-inherit data-highlighted:bg-transparent data-highlighted:text-inherit",
        props.isActive && "bg-accent! text-accent-foreground!",
      )}
      onMouseMove={() => {
        if (!props.isActive) props.onHighlight(props.item.id);
      }}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={() => {
        props.onSelect(props.item);
      }}
    >
      {props.item.type === "path" ? (
        <VscodeEntryIcon
          pathValue={props.item.path}
          kind={props.item.pathKind}
          theme={props.resolvedTheme}
        />
      ) : null}
      {props.item.type === "slash-command" ? (
        <BotIcon className="size-4 shrink-0 text-muted-foreground/80" />
      ) : null}
      {props.item.type === "provider-command" ? (
        props.item.commandKind === "plugin" ? (
          <PlugIcon className="size-4 shrink-0 text-violet-400/90" />
        ) : (
          <IconStack2 className="size-4 shrink-0 text-cyan-400/90" />
        )
      ) : null}
      {props.item.type === "model" ? (
        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
          model
        </Badge>
      ) : null}
      {props.item.type === "issue" ? (
        <HashIcon className="size-4 shrink-0 text-blue-400/90" />
      ) : null}
      <span className="grid min-w-0 flex-1 grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5">
        <span className="whitespace-nowrap">{props.item.label}</span>
        <span className="min-w-0 truncate text-muted-foreground/70 text-xs">
          {props.item.description}
        </span>
      </span>
    </CommandItem>
  );
});

import {
  ArrowUUpLeftIcon,
  CaretDownIcon,
  CaretRightIcon,
  FileIcon,
  GitDiffIcon,
  MinusIcon,
  PlusIcon,
} from "@ace/icons";
import { useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { EndName, FolderLabel } from "@/components/path/middle-name.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { cn } from "@/lib/cn.ts";
import {
  splitPath,
  targetPaths,
  type SourceControlItem,
  type SourceControlSection,
} from "./source-control-model.ts";

/**
 * One collapsible section of Source control (`Merge conflicts`, `Staged changes`, or `Changes`),
 * with section-level actions (Stage all, Unstage all, Discard all), ⌘/⇧-click multi-select rows,
 * subtle folder labels (`FolderLabel`), status letters in status colors, and bare hover action
 * icons with tooltips.
 */
export function FileSection(props: {
  section: SourceControlSection;
  title: string;
  items: readonly SourceControlItem[];
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSelect(
    path: string,
    modifiers: { meta: boolean; ctrl: boolean; shift: boolean },
    item: SourceControlItem,
  ): void;
  onOpenFile(path: string): void;
  onOpenChanges(item: SourceControlItem): void;
  onStage?(paths: readonly string[]): void;
  onStageAll?(): void;
  onUnstage?(paths: readonly string[]): void;
  onUnstageAll?(): void;
  onDiscard?(items: readonly SourceControlItem[]): void;
  onDiscardAll?(): void;
}) {
  const [open, setOpen] = useState(true);
  const { items, selected, section } = props;
  const orderedPaths = items.map((item) => item.path);
  const byPath = new Map(items.map((item) => [item.path, item]));

  return (
    <section aria-label={props.title} data-part="source-control-section" className="flex flex-col">
      <div className="group flex h-7 shrink-0 items-center gap-1 px-1.5 hover:bg-hover/60">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground focus-ring"
        >
          <Icon
            icon={open ? CaretDownIcon : CaretRightIcon}
            size={12}
            className="shrink-0 text-subtle-foreground"
          />
          <span className={cn("min-w-0 truncate", section === "conflicts" && "text-status-failed")}>
            {props.title}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--motion-fast) group-hover:opacity-100 group-focus-within:opacity-100">
          {props.onDiscardAll && (
            <IconButton
              icon={ArrowUUpLeftIcon}
              label="Discard all"
              size="sm"
              disabled={props.disabled || items.length === 0}
              onClick={props.onDiscardAll}
              className="size-5 rounded-sm hover:bg-hover"
            />
          )}
          {props.onStageAll && (
            <IconButton
              icon={PlusIcon}
              label="Stage all"
              size="sm"
              disabled={props.disabled || items.length === 0}
              onClick={props.onStageAll}
              className="size-5 rounded-sm hover:bg-hover"
            />
          )}
          {props.onUnstageAll && (
            <IconButton
              icon={MinusIcon}
              label="Unstage all"
              size="sm"
              disabled={props.disabled || items.length === 0}
              onClick={props.onUnstageAll}
              className="size-5 rounded-sm hover:bg-hover"
            />
          )}
        </div>

        <span className="min-w-4 shrink-0 text-right font-mono text-[11px] tabular-nums text-subtle-foreground">
          {items.length}
        </span>
      </div>

      {open && (
        <ul
          role="listbox"
          aria-label={props.title}
          aria-multiselectable="true"
          className="flex flex-col"
        >
          {items.map((item) => {
            const { name, folder } = splitPath(item.path);
            const isSelected = selected.has(item.path);
            const targets = targetPaths(orderedPaths, selected, item.path);
            const targetCount = targets.length;
            const targetItems = targets
              .map((path) => byPath.get(path))
              .filter((found): found is SourceControlItem => found !== undefined);
            const plural = targetCount > 1 ? ` (${targetCount} files)` : "";

            return (
              <li
                key={item.path}
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected ? "" : undefined}
                title={item.oldPath ? `${item.oldPath} → ${item.path}` : item.path}
                className={cn(
                  "group/row relative flex h-6.5 items-center gap-1 pr-2 pl-4 text-xs select-none",
                  isSelected ? "bg-active text-foreground" : "text-foreground hover:bg-hover",
                )}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    props.onSelect(
                      item.path,
                      { meta: event.metaKey, ctrl: event.ctrlKey, shift: event.shiftKey },
                      item,
                    );
                  }}
                  onDoubleClick={() => props.onOpenFile(item.path)}
                  className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left focus-ring"
                >
                  <EndName
                    text={name}
                    kind="file"
                    className={cn(
                      "shrink-0 max-w-[75%]",
                      item.letter === "D" && "line-through text-muted-foreground",
                    )}
                  />
                  {folder && (
                    <FolderLabel folder={folder} className="text-[11px] text-subtle-foreground" />
                  )}
                </button>

                <div
                  className={cn(
                    "hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex",
                  )}
                >
                  <IconButton
                    icon={FileIcon}
                    label={`Open file ${name}`}
                    tip="Open file"
                    size="sm"
                    onClick={() => props.onOpenFile(item.path)}
                    className="size-5 rounded-sm hover:bg-hover"
                  />
                  <IconButton
                    icon={GitDiffIcon}
                    label={`Open changes for ${name}`}
                    tip="Open changes"
                    size="sm"
                    onClick={() => props.onOpenChanges(item)}
                    className="size-5 rounded-sm hover:bg-hover"
                  />
                  {props.onDiscard && (
                    <IconButton
                      icon={ArrowUUpLeftIcon}
                      label={`Discard ${targetCount > 1 ? `${targetCount} files` : name}`}
                      tip={`Discard${plural}`}
                      size="sm"
                      disabled={props.disabled}
                      onClick={() => props.onDiscard?.(targetItems)}
                      className="size-5 rounded-sm hover:bg-hover"
                    />
                  )}
                  {props.onStage && (
                    <IconButton
                      icon={PlusIcon}
                      label={`Stage ${targetCount > 1 ? `${targetCount} files` : name}`}
                      tip={`Stage${plural}`}
                      size="sm"
                      disabled={props.disabled}
                      onClick={() => props.onStage?.(targets)}
                      className="size-5 rounded-sm hover:bg-hover"
                    />
                  )}
                  {props.onUnstage && (
                    <IconButton
                      icon={MinusIcon}
                      label={`Unstage ${targetCount > 1 ? `${targetCount} files` : name}`}
                      tip={`Unstage${plural}`}
                      size="sm"
                      disabled={props.disabled}
                      onClick={() => props.onUnstage?.(targets)}
                      className="size-5 rounded-sm hover:bg-hover"
                    />
                  )}
                </div>

                <span
                  aria-label={item.statusLabel}
                  title={item.statusLabel}
                  className={cn(
                    "w-3.5 shrink-0 text-center font-mono text-[11px] font-semibold",
                    item.colorClass,
                  )}
                >
                  {item.letter}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

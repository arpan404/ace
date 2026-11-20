import {
  closeTabs,
  copyTab,
  discardTabs,
  focusedGroup,
  groupsOf,
  keepTab,
  activateTab,
  type EditorLayout,
  type TabRef,
} from "@ace/ui-core/editor-workbench";
import type { DeckBuffers } from "@/features/editor-workbench/index.ts";
import { groupIds, openPaths } from "./deck-layout.ts";
import { askReplace, askUnsaved } from "./unsaved-prompt.tsx";

/*
 * What the Deck does with its buffers beyond the layout (spec 46–48): saving through the versioned
 * write, raising "Replace Claude Code's changes?" when a save meets an agent's change, and asking
 * Save / Don't save / Cancel before unsaved text could be dropped. The panel calls these with the
 * layout as it is at the moment of the answer.
 */

export type SaveProblem = { path: string; message: string } | undefined;

export interface DeckActionsHost {
  buffers: DeckBuffers;
  /** The layout now (answers come back after awaits). */
  layout(): EditorLayout;
  change(next: EditorLayout): void;
  online(): boolean;
  /** A save couldn't happen: what to say in the status line, or undefined to clear it. */
  problem(problem: SaveProblem | "offline"): void;
}

const fileName = (path: string) => path.split("/").at(-1) ?? path;

/** Paths of the layout with unsaved edits now. */
export function unsavedOf(host: DeckActionsHost): Set<string> {
  return new Set(openPaths(host.layout()).filter((path) => host.buffers.snapshot(path)?.dirty));
}

/** Save one file. True once it is saved (or had nothing to save). */
export async function saveFile(host: DeckActionsHost, path: string): Promise<boolean> {
  const buffer = host.buffers.buffer(path);
  if (!buffer) return true;
  if (!host.online()) {
    host.problem("offline");
    return false;
  }
  const outcome = await buffer.save();
  if (outcome.kind === "saved" || outcome.kind === "unchanged") {
    host.problem(undefined);
    return true;
  }
  if (outcome.kind === "clash") {
    const clash = buffer.snapshot().clash;
    const who = clash ? host.buffers.changer(clash.by)?.name : undefined;
    const answer = await askReplace(path, who);
    if (answer === "replace") return (await buffer.replace()).kind === "saved";
    if (answer === "merge") await buffer.merge();
    return false;
  }
  if (outcome.kind === "unanswered")
    host.problem({ path, message: `Answer each conflicting block in ${fileName(path)} first.` });
  if (outcome.kind === "failed") host.problem({ path, message: outcome.message });
  return false;
}

/** Save every unsaved open file. */
export async function saveAll(host: DeckActionsHost): Promise<void> {
  for (const path of unsavedOf(host)) await saveFile(host, path);
}

/**
 * Close tabs; the last views of unsaved files ask first (one dialog for all of them). Save
 * closes them once saved; Don't save drops the edits and the drafts; Cancel keeps them.
 */
export async function closeEditors(host: DeckActionsHost, refs: readonly TabRef[]): Promise<void> {
  if (refs.length === 0) return;
  const result = closeTabs(host.layout(), refs, unsavedOf(host));
  if (result.layout !== host.layout()) host.change(result.layout);
  if (result.asking.length > 0) await confirmClose(host, result.asking);
}

/** The tabs W3 left open because closing them would lose unsaved text: ask, then act. */
export async function confirmClose(host: DeckActionsHost, refs: readonly TabRef[]): Promise<void> {
  const paths = [...new Set(refs.map((ref) => ref.path))];
  const answer = await askUnsaved(paths);
  if (answer === "cancel") return;
  if (answer === "save") {
    const saved: string[] = [];
    for (const path of paths) if (await saveFile(host, path)) saved.push(path);
    const closing = refs.filter((ref) => saved.includes(ref.path));
    host.change(closeTabs(host.layout(), closing, unsavedOf(host)).layout);
    return;
  }
  await Promise.all(paths.map((path) => host.buffers.buffer(path)?.discard()));
  host.change(discardTabs(host.layout(), refs));
}

/** Every tab in every group. */
export function allTabs(layout: EditorLayout): TabRef[] {
  return groupsOf(layout).flatMap((group) =>
    group.tabs.map((tab) => ({ group: group.id, path: tab.path })),
  );
}

/** A second view of the focused editor beside (or under) it. */
export function splitFocused(layout: EditorLayout, side: "right" | "down"): EditorLayout {
  const group = focusedGroup(layout);
  if (group.active === undefined) return layout;
  return copyTab(
    layout,
    { group: group.id, path: group.active },
    { kind: "side", group: group.id, side },
    groupIds(layout),
  );
}

/** Show a path where it is open (the focused group first), for Next change. */
export function showPath(layout: EditorLayout, path: string): EditorLayout {
  const focused = focusedGroup(layout);
  const group = focused.tabs.some((tab) => tab.path === path)
    ? focused
    : groupsOf(layout).find((each) => each.tabs.some((tab) => tab.path === path));
  return group ? activateTab(layout, { group: group.id, path }) : layout;
}

/** Spec 10: typing in a preview keeps it. */
export function keepTypedPreviews(layout: EditorLayout, buffers: DeckBuffers): EditorLayout {
  let next = layout;
  for (const group of groupsOf(layout))
    for (const tab of group.tabs)
      if (tab.preview && buffers.snapshot(tab.path)?.dirty)
        next = keepTab(next, { group: group.id, path: tab.path });
  return next;
}

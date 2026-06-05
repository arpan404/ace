/**
 * Single Zustand store for terminal UI state keyed by thread id.
 *
 * Terminal transition helpers are intentionally private to keep the public
 * API constrained to store actions/selectors.
 */

import type { ThreadId } from "@ace/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  normalizeTerminalColorName,
  normalizeTerminalIconName,
  type TerminalColorName,
  type TerminalIconName,
} from "./lib/terminalAppearance";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_THREAD_TERMINAL_HEIGHT,
  DEFAULT_THREAD_TERMINAL_ID,
  MAX_TERMINALS_PER_GROUP,
  type ThreadTerminalGroup,
} from "./types";
import {
  assignUniqueTerminalGroupId as assignUniqueGroupId,
  DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  fallbackTerminalGroupId as fallbackGroupId,
  normalizeOptionalTerminalIdList,
  normalizeTerminalGroups,
  normalizeTerminalIdList as normalizeTerminalIds,
  normalizeTerminalSidebarWidth,
} from "./lib/terminalStateNormalization";

export type TerminalPanelPlacement = "bottom" | "right";

const RIGHT_PANEL_DEFAULT_TERMINAL_ID = "right-default";

interface ThreadTerminalPanelState {
  terminalOpen: boolean;
  terminalHeight: number;
  terminalIds: string[];
  activeTerminalId: string;
  terminalGroups: ThreadTerminalGroup[];
  activeTerminalGroupId: string;
  splitRatiosByGroupId: Record<string, number[]>;
}

interface ThreadTerminalState extends ThreadTerminalPanelState {
  terminalSidebarWidth: number;
  terminalSidebarDensity: "compact" | "comfortable";
  terminalSessionIds: string[];
  runningTerminalIds: string[];
  customTerminalTitlesById: Record<string, string>;
  autoTerminalTitlesById: Record<string, string>;
  terminalIconsById: Record<string, TerminalIconName>;
  terminalColorsById: Record<string, TerminalColorName>;
  terminalPanelStateByPlacement: Record<TerminalPanelPlacement, ThreadTerminalPanelState>;
}

const TERMINAL_STATE_STORAGE_KEY = "ace:terminal-state:v1";
const normalizedThreadTerminalStateCache = new WeakMap<object, ThreadTerminalState>();

function createTerminalStateStorage() {
  return resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined);
}

function normalizeTerminalSidebarDensity(
  density: string | null | undefined,
): "compact" | "comfortable" {
  return density === "compact" ? "compact" : "comfortable";
}

function normalizeRunningTerminalIds(
  runningTerminalIds: string[],
  terminalIds: string[],
): string[] {
  if (runningTerminalIds.length === 0) return [];
  return normalizeOptionalTerminalIdList(runningTerminalIds, new Set(terminalIds));
}

function normalizeTerminalTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const normalized = title.trim().replace(/\s+/g, " ");
  if (normalized.length === 0) return null;
  return normalized.slice(0, 80);
}

function normalizeTerminalTitleMap(
  titlesById: Record<string, string> | null | undefined,
  terminalIds: string[],
): Record<string, string> {
  if (!titlesById || typeof titlesById !== "object") {
    return {};
  }
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries: Array<[string, string]> = [];
  for (const [terminalId, title] of Object.entries(titlesById)) {
    if (!validTerminalIdSet.has(terminalId)) continue;
    const normalizedTitle = normalizeTerminalTitle(title);
    if (!normalizedTitle) continue;
    normalizedEntries.push([terminalId, normalizedTitle]);
  }
  return Object.fromEntries(normalizedEntries);
}

function normalizeTerminalMetadataMap<T extends string>(
  metadataById: Record<string, string> | null | undefined,
  terminalIds: string[],
  normalizer: (value: string | null | undefined) => T | null,
): Record<string, T> {
  if (!metadataById || typeof metadataById !== "object") {
    return {};
  }
  const validTerminalIdSet = new Set(terminalIds);
  const normalizedEntries: Array<[string, T]> = [];
  for (const [terminalId, value] of Object.entries(metadataById)) {
    if (!validTerminalIdSet.has(terminalId)) continue;
    const normalizedValue = normalizer(value);
    if (!normalizedValue) continue;
    normalizedEntries.push([terminalId, normalizedValue]);
  }
  return Object.fromEntries(normalizedEntries);
}

function findGroupIndexByTerminalId(
  terminalGroups: ThreadTerminalGroup[],
  terminalId: string,
): number {
  return terminalGroups.findIndex((group) => group.terminalIds.includes(terminalId));
}

function createEqualSplitRatios(count: number): number[] {
  if (count <= 0) return [];
  const ratio = 1 / count;
  return Array.from({ length: count }, () => ratio);
}

function normalizeSplitRatios(ratios: number[] | null | undefined, count: number): number[] {
  if (count <= 0) return [];
  if (!Array.isArray(ratios) || ratios.length !== count) {
    return createEqualSplitRatios(count);
  }
  const sanitized = ratios.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return createEqualSplitRatios(count);
  }
  return sanitized.map((value) => value / total);
}

function normalizeSplitRatiosByGroupId(
  splitRatiosByGroupId: Record<string, number[]> | null | undefined,
  terminalGroups: ThreadTerminalGroup[],
): Record<string, number[]> {
  const source =
    splitRatiosByGroupId && typeof splitRatiosByGroupId === "object" ? splitRatiosByGroupId : {};
  return Object.fromEntries(
    terminalGroups.map((group) => [
      group.id,
      normalizeSplitRatios(source[group.id], group.terminalIds.length),
    ]),
  );
}

function arraysEqual(
  a: readonly string[] | null | undefined,
  b: readonly string[] | null | undefined,
): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function numberArraysEqual(
  left: readonly number[] | null | undefined,
  right: readonly number[] | null | undefined,
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index];
    const rightValue = right[index];
    if (leftValue === undefined || rightValue === undefined) return false;
    if (Math.abs(leftValue - rightValue) > 0.0001) return false;
  }
  return true;
}

function stringRecordEqual(
  left: Record<string, string> | null | undefined,
  right: Record<string, string> | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (!arraysEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => left[key] === right[key]);
}

function splitRatioRecordEqual(
  left: Record<string, number[]> | null | undefined,
  right: Record<string, number[]> | null | undefined,
): boolean {
  if (!left || !right) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (!arraysEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => {
    const leftValue = left[key];
    const rightValue = right[key];
    if (!leftValue || !rightValue) return false;
    return numberArraysEqual(leftValue, rightValue);
  });
}

function terminalGroupsEqual(
  left: readonly ThreadTerminalGroup[] | null | undefined,
  right: readonly ThreadTerminalGroup[] | null | undefined,
): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftGroup = left[index];
    const rightGroup = right[index];
    if (!leftGroup || !rightGroup) return false;
    if (leftGroup.id !== rightGroup.id) return false;
    if (!arraysEqual(leftGroup.terminalIds, rightGroup.terminalIds)) return false;
  }
  return true;
}

function terminalPanelStateEqual(
  left: ThreadTerminalPanelState | null | undefined,
  right: ThreadTerminalPanelState | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups) &&
    splitRatioRecordEqual(left.splitRatiosByGroupId, right.splitRatiosByGroupId)
  );
}

function terminalPanelStateByPlacementEqual(
  left: Record<TerminalPanelPlacement, ThreadTerminalPanelState> | null | undefined,
  right: Record<TerminalPanelPlacement, ThreadTerminalPanelState> | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    terminalPanelStateEqual(left.bottom, right.bottom) &&
    terminalPanelStateEqual(left.right, right.right)
  );
}

function threadTerminalStateEqual(left: ThreadTerminalState, right: ThreadTerminalState): boolean {
  return (
    left.terminalOpen === right.terminalOpen &&
    left.terminalHeight === right.terminalHeight &&
    left.terminalSidebarWidth === right.terminalSidebarWidth &&
    left.terminalSidebarDensity === right.terminalSidebarDensity &&
    left.activeTerminalId === right.activeTerminalId &&
    left.activeTerminalGroupId === right.activeTerminalGroupId &&
    arraysEqual(left.terminalIds, right.terminalIds) &&
    arraysEqual(left.terminalSessionIds, right.terminalSessionIds) &&
    arraysEqual(left.runningTerminalIds, right.runningTerminalIds) &&
    terminalGroupsEqual(left.terminalGroups, right.terminalGroups) &&
    stringRecordEqual(left.customTerminalTitlesById, right.customTerminalTitlesById) &&
    stringRecordEqual(left.autoTerminalTitlesById, right.autoTerminalTitlesById) &&
    stringRecordEqual(left.terminalIconsById, right.terminalIconsById) &&
    stringRecordEqual(left.terminalColorsById, right.terminalColorsById) &&
    splitRatioRecordEqual(left.splitRatiosByGroupId, right.splitRatiosByGroupId) &&
    terminalPanelStateByPlacementEqual(
      left.terminalPanelStateByPlacement,
      right.terminalPanelStateByPlacement,
    )
  );
}

function defaultTerminalIdForPlacement(placement: TerminalPanelPlacement): string {
  return placement === "right" ? RIGHT_PANEL_DEFAULT_TERMINAL_ID : DEFAULT_THREAD_TERMINAL_ID;
}

function createDefaultThreadTerminalPanelState(
  placement: TerminalPanelPlacement,
): ThreadTerminalPanelState {
  const terminalId = defaultTerminalIdForPlacement(placement);
  return {
    terminalOpen: false,
    terminalHeight: DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: [terminalId],
    activeTerminalId: terminalId,
    terminalGroups: [
      {
        id: fallbackGroupId(terminalId),
        terminalIds: [terminalId],
      },
    ],
    activeTerminalGroupId: fallbackGroupId(terminalId),
    splitRatiosByGroupId: {
      [fallbackGroupId(terminalId)]: [1],
    },
  };
}

const DEFAULT_BOTTOM_TERMINAL_PANEL_STATE: ThreadTerminalPanelState = Object.freeze(
  createDefaultThreadTerminalPanelState("bottom"),
);

const DEFAULT_RIGHT_TERMINAL_PANEL_STATE: ThreadTerminalPanelState = Object.freeze(
  createDefaultThreadTerminalPanelState("right"),
);

const DEFAULT_THREAD_TERMINAL_STATE: ThreadTerminalState = Object.freeze({
  ...DEFAULT_BOTTOM_TERMINAL_PANEL_STATE,
  terminalSidebarWidth: DEFAULT_TERMINAL_SIDEBAR_WIDTH,
  terminalSidebarDensity: "comfortable",
  terminalSessionIds: [DEFAULT_THREAD_TERMINAL_ID, RIGHT_PANEL_DEFAULT_TERMINAL_ID],
  runningTerminalIds: [],
  customTerminalTitlesById: {},
  autoTerminalTitlesById: {},
  terminalIconsById: {},
  terminalColorsById: {},
  terminalPanelStateByPlacement: {
    bottom: DEFAULT_BOTTOM_TERMINAL_PANEL_STATE,
    right: DEFAULT_RIGHT_TERMINAL_PANEL_STATE,
  },
});

function createDefaultThreadTerminalState(): ThreadTerminalState {
  return {
    ...DEFAULT_THREAD_TERMINAL_STATE,
    terminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalIds],
    terminalSessionIds: [...DEFAULT_THREAD_TERMINAL_STATE.terminalSessionIds],
    runningTerminalIds: [...DEFAULT_THREAD_TERMINAL_STATE.runningTerminalIds],
    terminalGroups: copyTerminalGroups(DEFAULT_THREAD_TERMINAL_STATE.terminalGroups),
    customTerminalTitlesById: { ...DEFAULT_THREAD_TERMINAL_STATE.customTerminalTitlesById },
    autoTerminalTitlesById: { ...DEFAULT_THREAD_TERMINAL_STATE.autoTerminalTitlesById },
    terminalIconsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalIconsById },
    terminalColorsById: { ...DEFAULT_THREAD_TERMINAL_STATE.terminalColorsById },
    splitRatiosByGroupId: copySplitRatiosByGroupId(
      DEFAULT_THREAD_TERMINAL_STATE.splitRatiosByGroupId,
    ),
    terminalPanelStateByPlacement: {
      bottom: copyTerminalPanelState(
        DEFAULT_THREAD_TERMINAL_STATE.terminalPanelStateByPlacement.bottom,
      ),
      right: copyTerminalPanelState(
        DEFAULT_THREAD_TERMINAL_STATE.terminalPanelStateByPlacement.right,
      ),
    },
  };
}

function getDefaultThreadTerminalState(): ThreadTerminalState {
  return DEFAULT_THREAD_TERMINAL_STATE;
}

function getCachedNormalizedThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const cached = normalizedThreadTerminalStateCache.get(state);
  if (cached) return cached;
  const normalized = normalizeThreadTerminalState(state);
  normalizedThreadTerminalStateCache.set(state, normalized);
  return normalized;
}

function normalizeThreadTerminalState(state: ThreadTerminalState): ThreadTerminalState {
  const legacyBottomPanelState = normalizeThreadTerminalPanelState(
    {
      terminalOpen: state.terminalOpen,
      terminalHeight: state.terminalHeight,
      terminalIds: state.terminalIds,
      activeTerminalId: state.activeTerminalId,
      terminalGroups: state.terminalGroups,
      activeTerminalGroupId: state.activeTerminalGroupId,
      splitRatiosByGroupId: state.splitRatiosByGroupId,
    },
    state.terminalIds,
    "bottom",
  );
  const rightPanelState = normalizeThreadTerminalPanelState(
    state.terminalPanelStateByPlacement?.right ?? DEFAULT_RIGHT_TERMINAL_PANEL_STATE,
    state.terminalPanelStateByPlacement?.right?.terminalIds ?? [RIGHT_PANEL_DEFAULT_TERMINAL_ID],
    "right",
  );
  const bottomPanelState = normalizeThreadTerminalPanelState(
    state.terminalPanelStateByPlacement?.bottom ?? legacyBottomPanelState,
    state.terminalPanelStateByPlacement?.bottom?.terminalIds ?? legacyBottomPanelState.terminalIds,
    "bottom",
  );
  const terminalSessionIds = normalizeTerminalIds([
    ...bottomPanelState.terminalIds,
    ...rightPanelState.terminalIds,
    ...((state as Partial<ThreadTerminalState>).terminalSessionIds ?? []),
  ]);
  const runningTerminalIds = normalizeRunningTerminalIds(
    state.runningTerminalIds,
    terminalSessionIds,
  );
  const customTerminalTitlesById = normalizeTerminalTitleMap(
    state.customTerminalTitlesById,
    terminalSessionIds,
  );
  const autoTerminalTitlesById = normalizeTerminalTitleMap(
    state.autoTerminalTitlesById,
    terminalSessionIds,
  );
  const terminalIconsById = normalizeTerminalMetadataMap(
    state.terminalIconsById,
    terminalSessionIds,
    normalizeTerminalIconName,
  );
  const terminalColorsById = normalizeTerminalMetadataMap(
    state.terminalColorsById,
    terminalSessionIds,
    normalizeTerminalColorName,
  );

  const normalized: ThreadTerminalState = {
    ...bottomPanelState,
    terminalSidebarWidth: normalizeTerminalSidebarWidth(state.terminalSidebarWidth),
    terminalSidebarDensity: normalizeTerminalSidebarDensity(state.terminalSidebarDensity),
    terminalSessionIds,
    runningTerminalIds,
    customTerminalTitlesById,
    autoTerminalTitlesById,
    terminalIconsById,
    terminalColorsById,
    terminalPanelStateByPlacement: {
      bottom: bottomPanelState,
      right: rightPanelState,
    },
  };
  return threadTerminalStateEqual(state, normalized) ? state : normalized;
}

function isDefaultThreadTerminalState(state: ThreadTerminalState): boolean {
  const normalized = normalizeThreadTerminalState(state);
  return threadTerminalStateEqual(normalized, DEFAULT_THREAD_TERMINAL_STATE);
}

function isValidTerminalId(terminalId: string): boolean {
  return terminalId.trim().length > 0;
}

function copyTerminalGroups(groups: ThreadTerminalGroup[]): ThreadTerminalGroup[] {
  return groups.map((group) => ({
    id: group.id,
    terminalIds: [...group.terminalIds],
  }));
}

function copySplitRatiosByGroupId(
  splitRatiosByGroupId: Record<string, number[]>,
): Record<string, number[]> {
  return Object.fromEntries(
    Object.entries(splitRatiosByGroupId).map(([groupId, ratios]) => [groupId, [...ratios]]),
  );
}

function copyTerminalPanelState(panelState: ThreadTerminalPanelState): ThreadTerminalPanelState {
  return {
    terminalOpen: panelState.terminalOpen,
    terminalHeight: panelState.terminalHeight,
    terminalIds: [...panelState.terminalIds],
    activeTerminalId: panelState.activeTerminalId,
    terminalGroups: copyTerminalGroups(panelState.terminalGroups),
    activeTerminalGroupId: panelState.activeTerminalGroupId,
    splitRatiosByGroupId: copySplitRatiosByGroupId(panelState.splitRatiosByGroupId),
  };
}

function normalizeThreadTerminalPanelState(
  panelState: ThreadTerminalPanelState,
  terminalIds: string[],
  placement: TerminalPanelPlacement,
): ThreadTerminalPanelState {
  const fallbackTerminalId = defaultTerminalIdForPlacement(placement);
  const panelTerminalIds = normalizeTerminalIds(terminalIds, fallbackTerminalId);
  const activeTerminalId = panelTerminalIds.includes(panelState.activeTerminalId)
    ? panelState.activeTerminalId
    : (panelTerminalIds[0] ?? fallbackTerminalId);
  const terminalGroups = normalizeTerminalGroups(panelState.terminalGroups, panelTerminalIds);
  const splitRatiosByGroupId = normalizeSplitRatiosByGroupId(
    panelState.splitRatiosByGroupId,
    terminalGroups,
  );
  const activeGroupIdFromState = terminalGroups.some(
    (group) => group.id === panelState.activeTerminalGroupId,
  )
    ? panelState.activeTerminalGroupId
    : null;
  const activeGroupIdFromTerminal =
    terminalGroups.find((group) => group.terminalIds.includes(activeTerminalId))?.id ?? null;

  const normalized: ThreadTerminalPanelState = {
    terminalOpen: panelState.terminalOpen,
    terminalHeight:
      Number.isFinite(panelState.terminalHeight) && panelState.terminalHeight > 0
        ? panelState.terminalHeight
        : DEFAULT_THREAD_TERMINAL_HEIGHT,
    terminalIds: panelTerminalIds,
    activeTerminalId,
    terminalGroups,
    splitRatiosByGroupId,
    activeTerminalGroupId:
      activeGroupIdFromState ??
      activeGroupIdFromTerminal ??
      terminalGroups[0]?.id ??
      fallbackGroupId(fallbackTerminalId),
  };
  return terminalPanelStateEqual(panelState, normalized) ? panelState : normalized;
}

function panelStateFromThreadState(state: ThreadTerminalState): ThreadTerminalPanelState {
  return {
    terminalOpen: state.terminalOpen,
    terminalHeight: state.terminalHeight,
    terminalIds: state.terminalIds,
    activeTerminalId: state.activeTerminalId,
    terminalGroups: state.terminalGroups,
    activeTerminalGroupId: state.activeTerminalGroupId,
    splitRatiosByGroupId: state.splitRatiosByGroupId,
  };
}

function createThreadStateForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const panelState = normalized.terminalPanelStateByPlacement[placement];
  return {
    ...normalized,
    ...copyTerminalPanelState(panelState),
  };
}

function applyThreadStateForPanel(
  baseState: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  nextPanelThreadState: ThreadTerminalState,
): ThreadTerminalState {
  const normalizedBase = normalizeThreadTerminalState(baseState);
  const nextTerminalIds = normalizeTerminalIds(nextPanelThreadState.terminalIds);
  const normalizedNextTerminalIds =
    nextTerminalIds.length > 0 ? nextTerminalIds : [defaultTerminalIdForPlacement(placement)];
  const nextPanelState = normalizeThreadTerminalPanelState(
    panelStateFromThreadState(nextPanelThreadState),
    normalizedNextTerminalIds,
    placement,
  );
  const nextPanelsByPlacement = {
    ...normalizedBase.terminalPanelStateByPlacement,
    [placement]: nextPanelState,
  };
  const bottomPanelState =
    placement === "bottom" ? nextPanelState : normalizedBase.terminalPanelStateByPlacement.bottom;
  return normalizeThreadTerminalState({
    ...normalizedBase,
    ...copyTerminalPanelState(bottomPanelState),
    terminalSessionIds: normalizeTerminalIds([
      ...normalizedBase.terminalSessionIds,
      ...nextPanelState.terminalIds,
    ]),
    runningTerminalIds: normalizeRunningTerminalIds(
      nextPanelThreadState.runningTerminalIds,
      normalizeTerminalIds([...normalizedBase.terminalSessionIds, ...nextPanelState.terminalIds]),
    ),
    customTerminalTitlesById: normalizeTerminalTitleMap(
      nextPanelThreadState.customTerminalTitlesById,
      normalizeTerminalIds([...normalizedBase.terminalSessionIds, ...nextPanelState.terminalIds]),
    ),
    autoTerminalTitlesById: normalizeTerminalTitleMap(
      nextPanelThreadState.autoTerminalTitlesById,
      normalizeTerminalIds([...normalizedBase.terminalSessionIds, ...nextPanelState.terminalIds]),
    ),
    terminalIconsById: normalizeTerminalMetadataMap(
      nextPanelThreadState.terminalIconsById,
      normalizeTerminalIds([...normalizedBase.terminalSessionIds, ...nextPanelState.terminalIds]),
      normalizeTerminalIconName,
    ),
    terminalColorsById: normalizeTerminalMetadataMap(
      nextPanelThreadState.terminalColorsById,
      normalizeTerminalIds([...normalizedBase.terminalSessionIds, ...nextPanelState.terminalIds]),
      normalizeTerminalColorName,
    ),
    terminalPanelStateByPlacement: nextPanelsByPlacement,
  });
}

function setThreadTerminalOpenForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  open: boolean,
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (normalized.terminalOpen === open) return normalizeThreadTerminalState(state);
  return applyThreadStateForPanel(state, placement, { ...normalized, terminalOpen: open });
}

function setThreadTerminalOpen(state: ThreadTerminalState, open: boolean): ThreadTerminalState {
  return setThreadTerminalOpenForPanel(state, "bottom", open);
}

function setThreadTerminalHeightForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  height: number,
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (!Number.isFinite(height) || height <= 0 || normalized.terminalHeight === height) {
    return normalizeThreadTerminalState(state);
  }
  return applyThreadStateForPanel(state, placement, { ...normalized, terminalHeight: height });
}

function setThreadTerminalHeight(state: ThreadTerminalState, height: number): ThreadTerminalState {
  return setThreadTerminalHeightForPanel(state, "bottom", height);
}

function setThreadTerminalSidebarWidth(
  state: ThreadTerminalState,
  width: number,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextWidth = normalizeTerminalSidebarWidth(width);
  if (normalized.terminalSidebarWidth === nextWidth) {
    return normalized;
  }
  return { ...normalized, terminalSidebarWidth: nextWidth };
}

function setThreadTerminalSidebarDensity(
  state: ThreadTerminalState,
  density: "compact" | "comfortable",
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  const nextDensity = normalizeTerminalSidebarDensity(density);
  if (normalized.terminalSidebarDensity === nextDensity) {
    return normalized;
  }
  return { ...normalized, terminalSidebarDensity: nextDensity };
}

function upsertTerminalIntoGroupsForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
  mode: "split" | "new",
  options?: { terminalOpen?: boolean },
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (!isValidTerminalId(terminalId)) {
    return normalizeThreadTerminalState(state);
  }

  const isNewTerminal = !normalized.terminalIds.includes(terminalId);
  const terminalIds = isNewTerminal
    ? [...normalized.terminalIds, terminalId]
    : normalized.terminalIds;
  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);

  const existingGroupIndex = findGroupIndexByTerminalId(terminalGroups, terminalId);
  if (existingGroupIndex >= 0) {
    terminalGroups[existingGroupIndex]!.terminalIds = terminalGroups[
      existingGroupIndex
    ]!.terminalIds.filter((id) => id !== terminalId);
    if (terminalGroups[existingGroupIndex]!.terminalIds.length === 0) {
      terminalGroups.splice(existingGroupIndex, 1);
    }
  }

  if (mode === "new") {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds);
    terminalGroups.push({ id: nextGroupId, terminalIds: [terminalId] });
    return applyThreadStateForPanel(state, placement, {
      ...normalized,
      terminalOpen: options?.terminalOpen ?? true,
      terminalIds,
      activeTerminalId: terminalId,
      terminalGroups,
      activeTerminalGroupId: nextGroupId,
    });
  }

  let activeGroupIndex = terminalGroups.findIndex(
    (group) => group.id === normalized.activeTerminalGroupId,
  );
  if (activeGroupIndex < 0) {
    activeGroupIndex = findGroupIndexByTerminalId(terminalGroups, normalized.activeTerminalId);
  }
  if (activeGroupIndex < 0) {
    const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
    const nextGroupId = assignUniqueGroupId(
      fallbackGroupId(normalized.activeTerminalId),
      usedGroupIds,
    );
    terminalGroups.push({ id: nextGroupId, terminalIds: [normalized.activeTerminalId] });
    activeGroupIndex = terminalGroups.length - 1;
  }

  const destinationGroup = terminalGroups[activeGroupIndex];
  if (!destinationGroup) {
    return normalizeThreadTerminalState(state);
  }

  if (
    isNewTerminal &&
    !destinationGroup.terminalIds.includes(terminalId) &&
    destinationGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalizeThreadTerminalState(state);
  }

  if (!destinationGroup.terminalIds.includes(terminalId)) {
    const anchorIndex = destinationGroup.terminalIds.indexOf(normalized.activeTerminalId);
    if (anchorIndex >= 0) {
      destinationGroup.terminalIds.splice(anchorIndex + 1, 0, terminalId);
    } else {
      destinationGroup.terminalIds.push(terminalId);
    }
  }

  return applyThreadStateForPanel(state, placement, {
    ...normalized,
    terminalOpen: options?.terminalOpen ?? true,
    terminalIds,
    activeTerminalId: terminalId,
    terminalGroups,
    activeTerminalGroupId: destinationGroup.id,
  });
}

function splitThreadTerminalForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
): ThreadTerminalState {
  return upsertTerminalIntoGroupsForPanel(state, placement, terminalId, "split");
}

function splitThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return splitThreadTerminalForPanel(state, "bottom", terminalId);
}

function newThreadTerminalForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
): ThreadTerminalState {
  return upsertTerminalIntoGroupsForPanel(state, placement, terminalId, "new");
}

function newThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  return newThreadTerminalForPanel(state, "bottom", terminalId);
}

function setThreadActiveTerminalForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalizeThreadTerminalState(state);
  }
  const activeTerminalGroupId =
    normalized.terminalGroups.find((group) => group.terminalIds.includes(terminalId))?.id ??
    normalized.activeTerminalGroupId;
  if (
    normalized.activeTerminalId === terminalId &&
    normalized.activeTerminalGroupId === activeTerminalGroupId
  ) {
    return normalizeThreadTerminalState(state);
  }
  return applyThreadStateForPanel(state, placement, {
    ...normalized,
    activeTerminalId: terminalId,
    activeTerminalGroupId,
  });
}

function setThreadActiveTerminal(
  state: ThreadTerminalState,
  terminalId: string,
): ThreadTerminalState {
  return setThreadActiveTerminalForPanel(state, "bottom", terminalId);
}

function closeThreadTerminal(state: ThreadTerminalState, terminalId: string): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }

  const remainingTerminalSessionIds = normalized.terminalSessionIds.filter(
    (id) => id !== terminalId,
  );
  if (remainingTerminalSessionIds.length === 0) {
    return createDefaultThreadTerminalState();
  }

  const closedTerminalIndex = normalized.terminalSessionIds.indexOf(terminalId);
  const closePanelState = (
    panelState: ThreadTerminalPanelState,
    placement: TerminalPanelPlacement,
  ): ThreadTerminalPanelState => {
    const remainingPanelTerminalIds = panelState.terminalIds.filter((id) => id !== terminalId);
    if (remainingPanelTerminalIds.length === panelState.terminalIds.length) {
      return panelState;
    }
    const nextPanelTerminalIds =
      remainingPanelTerminalIds.length > 0
        ? remainingPanelTerminalIds
        : [defaultTerminalIdForPlacement(placement)];
    const nextActiveTerminalId =
      panelState.activeTerminalId === terminalId
        ? (nextPanelTerminalIds[Math.min(closedTerminalIndex, nextPanelTerminalIds.length - 1)] ??
          nextPanelTerminalIds[0] ??
          defaultTerminalIdForPlacement(placement))
        : panelState.activeTerminalId;

    const terminalGroups = panelState.terminalGroups.flatMap((group) => {
      const terminalIds = group.terminalIds.filter((id) => id !== terminalId);
      return terminalIds.length > 0 ? [{ ...group, terminalIds }] : [];
    });

    const nextActiveTerminalGroupId =
      terminalGroups.find((group) => group.terminalIds.includes(nextActiveTerminalId))?.id ??
      terminalGroups[0]?.id ??
      fallbackGroupId(nextActiveTerminalId);

    return normalizeThreadTerminalPanelState(
      {
        ...panelState,
        terminalIds: nextPanelTerminalIds,
        activeTerminalId: nextActiveTerminalId,
        terminalGroups,
        activeTerminalGroupId: nextActiveTerminalGroupId,
      },
      nextPanelTerminalIds,
      placement,
    );
  };
  const bottomPanelState = closePanelState(
    normalized.terminalPanelStateByPlacement.bottom,
    "bottom",
  );
  const rightPanelState = closePanelState(normalized.terminalPanelStateByPlacement.right, "right");

  return normalizeThreadTerminalState({
    ...normalized,
    ...bottomPanelState,
    terminalSidebarWidth: normalized.terminalSidebarWidth,
    terminalSidebarDensity: normalized.terminalSidebarDensity,
    terminalSessionIds: normalizeTerminalIds([
      ...bottomPanelState.terminalIds,
      ...rightPanelState.terminalIds,
      ...remainingTerminalSessionIds,
    ]),
    runningTerminalIds: normalized.runningTerminalIds.filter((id) => id !== terminalId),
    customTerminalTitlesById: normalized.customTerminalTitlesById,
    autoTerminalTitlesById: normalized.autoTerminalTitlesById,
    terminalIconsById: normalized.terminalIconsById,
    terminalColorsById: normalized.terminalColorsById,
    terminalPanelStateByPlacement: {
      bottom: bottomPanelState,
      right: rightPanelState,
    },
  });
}

function setThreadTerminalActivity(
  state: ThreadTerminalState,
  terminalId: string,
  hasRunningSubprocess: boolean,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }
  const alreadyRunning = normalized.runningTerminalIds.includes(terminalId);
  if (hasRunningSubprocess === alreadyRunning) {
    return normalized;
  }
  const runningTerminalIds = new Set(normalized.runningTerminalIds);
  if (hasRunningSubprocess) {
    runningTerminalIds.add(terminalId);
  } else {
    runningTerminalIds.delete(terminalId);
  }
  return { ...normalized, runningTerminalIds: [...runningTerminalIds] };
}

function setThreadTerminalCustomTitle(
  state: ThreadTerminalState,
  terminalId: string,
  title: string,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitle = normalizeTerminalTitle(title);
  const currentTitle = normalized.customTerminalTitlesById[terminalId] ?? null;
  if (currentTitle === normalizedTitle) {
    return normalized;
  }
  const customTerminalTitlesById = { ...normalized.customTerminalTitlesById };
  if (normalizedTitle) {
    customTerminalTitlesById[terminalId] = normalizedTitle;
  } else {
    delete customTerminalTitlesById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    customTerminalTitlesById,
  });
}

function setThreadTerminalAutoTitle(
  state: ThreadTerminalState,
  terminalId: string,
  title: string | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedTitle = normalizeTerminalTitle(title);
  const currentTitle = normalized.autoTerminalTitlesById[terminalId] ?? null;
  if (currentTitle === normalizedTitle) {
    return normalized;
  }
  const autoTerminalTitlesById = { ...normalized.autoTerminalTitlesById };
  if (normalizedTitle) {
    autoTerminalTitlesById[terminalId] = normalizedTitle;
  } else {
    delete autoTerminalTitlesById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    autoTerminalTitlesById,
  });
}

function setThreadTerminalIcon(
  state: ThreadTerminalState,
  terminalId: string,
  icon: TerminalIconName | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedIcon = normalizeTerminalIconName(icon);
  const currentIcon = normalized.terminalIconsById[terminalId] ?? null;
  if (currentIcon === normalizedIcon) {
    return normalized;
  }
  const terminalIconsById = { ...normalized.terminalIconsById };
  if (normalizedIcon) {
    terminalIconsById[terminalId] = normalizedIcon;
  } else {
    delete terminalIconsById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    terminalIconsById,
  });
}

function setThreadTerminalColor(
  state: ThreadTerminalState,
  terminalId: string,
  color: TerminalColorName | null,
): ThreadTerminalState {
  const normalized = normalizeThreadTerminalState(state);
  if (!normalized.terminalSessionIds.includes(terminalId)) {
    return normalized;
  }
  const normalizedColor = normalizeTerminalColorName(color);
  const currentColor = normalized.terminalColorsById[terminalId] ?? null;
  if (currentColor === normalizedColor) {
    return normalized;
  }
  const terminalColorsById = { ...normalized.terminalColorsById };
  if (normalizedColor) {
    terminalColorsById[terminalId] = normalizedColor;
  } else {
    delete terminalColorsById[terminalId];
  }
  return normalizeThreadTerminalState({
    ...normalized,
    terminalColorsById,
  });
}

function setThreadTerminalGroupSplitRatiosForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  groupId: string,
  ratios: number[],
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  const group = normalized.terminalGroups.find((candidate) => candidate.id === groupId);
  if (!group) {
    return normalizeThreadTerminalState(state);
  }
  const nextRatios = normalizeSplitRatios(ratios, group.terminalIds.length);
  const currentRatios = normalized.splitRatiosByGroupId[groupId];
  if (currentRatios && numberArraysEqual(currentRatios, nextRatios)) {
    return normalizeThreadTerminalState(state);
  }
  return applyThreadStateForPanel(state, placement, {
    ...normalized,
    splitRatiosByGroupId: {
      ...normalized.splitRatiosByGroupId,
      [groupId]: nextRatios,
    },
  });
}

function setThreadTerminalGroupSplitRatios(
  state: ThreadTerminalState,
  groupId: string,
  ratios: number[],
): ThreadTerminalState {
  return setThreadTerminalGroupSplitRatiosForPanel(state, "bottom", groupId, ratios);
}

function moveThreadTerminalForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
  targetGroupId: string,
  targetIndex: number,
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalizeThreadTerminalState(state);
  }

  const sourceGroupIndex = normalized.terminalGroups.findIndex((group) =>
    group.terminalIds.includes(terminalId),
  );
  const targetGroupIndex = normalized.terminalGroups.findIndex(
    (group) => group.id === targetGroupId,
  );
  if (sourceGroupIndex < 0 || targetGroupIndex < 0) {
    return normalizeThreadTerminalState(state);
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const sourceGroup = terminalGroups[sourceGroupIndex];
  const initialTargetGroup = terminalGroups[targetGroupIndex];
  if (!sourceGroup || !initialTargetGroup) {
    return normalizeThreadTerminalState(state);
  }

  const sourceIndex = sourceGroup.terminalIds.indexOf(terminalId);
  if (sourceIndex < 0) {
    return normalizeThreadTerminalState(state);
  }

  if (
    sourceGroup.id !== initialTargetGroup.id &&
    initialTargetGroup.terminalIds.length >= MAX_TERMINALS_PER_GROUP
  ) {
    return normalized;
  }

  if (sourceGroup.id === initialTargetGroup.id) {
    const finalIndex = Math.max(0, Math.min(targetIndex, sourceGroup.terminalIds.length - 1));
    if (sourceIndex === finalIndex) {
      return normalizeThreadTerminalState(state);
    }
  }

  sourceGroup.terminalIds.splice(sourceIndex, 1);
  let nextTargetGroupIndex = targetGroupIndex;
  if (sourceGroup.terminalIds.length === 0) {
    terminalGroups.splice(sourceGroupIndex, 1);
    if (sourceGroupIndex < targetGroupIndex) {
      nextTargetGroupIndex -= 1;
    }
  }

  const targetGroup = terminalGroups[nextTargetGroupIndex];
  if (!targetGroup) {
    return normalizeThreadTerminalState(state);
  }

  let insertionIndex = Math.max(0, Math.min(targetIndex, targetGroup.terminalIds.length));

  const targetIds = targetGroup.terminalIds;
  if (sourceGroup.id === targetGroup.id && sourceIndex === insertionIndex) {
    return normalizeThreadTerminalState(state);
  }

  targetIds.splice(insertionIndex, 0, terminalId);
  const terminalIds = terminalGroups.flatMap((group) => group.terminalIds);
  const activeTerminalGroupId =
    terminalGroups.find((group) => group.terminalIds.includes(normalized.activeTerminalId))?.id ??
    terminalGroups[0]?.id ??
    fallbackGroupId(normalized.activeTerminalId);

  return applyThreadStateForPanel(state, placement, {
    ...normalized,
    terminalIds,
    terminalGroups,
    activeTerminalGroupId,
  });
}

function moveThreadTerminal(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupId: string,
  targetIndex: number,
): ThreadTerminalState {
  return moveThreadTerminalForPanel(state, "bottom", terminalId, targetGroupId, targetIndex);
}

function moveThreadTerminalToNewGroupForPanel(
  state: ThreadTerminalState,
  placement: TerminalPanelPlacement,
  terminalId: string,
  targetGroupIndex: number,
): ThreadTerminalState {
  const normalized = createThreadStateForPanel(state, placement);
  if (!normalized.terminalIds.includes(terminalId)) {
    return normalizeThreadTerminalState(state);
  }

  const sourceGroupIndex = normalized.terminalGroups.findIndex((group) =>
    group.terminalIds.includes(terminalId),
  );
  if (sourceGroupIndex < 0) {
    return normalizeThreadTerminalState(state);
  }

  const sourceGroup = normalized.terminalGroups[sourceGroupIndex];
  if (!sourceGroup) {
    return normalizeThreadTerminalState(state);
  }
  if (sourceGroup.terminalIds.length === 1) {
    return normalizeThreadTerminalState(state);
  }

  const terminalGroups = copyTerminalGroups(normalized.terminalGroups);
  const mutableSourceGroup = terminalGroups[sourceGroupIndex];
  if (!mutableSourceGroup) {
    return normalizeThreadTerminalState(state);
  }
  mutableSourceGroup.terminalIds = mutableSourceGroup.terminalIds.filter((id) => id !== terminalId);

  const usedGroupIds = new Set(terminalGroups.map((group) => group.id));
  const newGroup: ThreadTerminalGroup = {
    id: assignUniqueGroupId(fallbackGroupId(terminalId), usedGroupIds),
    terminalIds: [terminalId],
  };
  const insertionIndex = Math.max(0, Math.min(targetGroupIndex, terminalGroups.length));
  terminalGroups.splice(insertionIndex, 0, newGroup);

  const terminalIds = terminalGroups.flatMap((group) => group.terminalIds);
  return applyThreadStateForPanel(state, placement, {
    ...normalized,
    terminalIds,
    terminalGroups,
    activeTerminalGroupId:
      terminalGroups.find((group) => group.terminalIds.includes(normalized.activeTerminalId))?.id ??
      terminalGroups[0]?.id ??
      fallbackGroupId(normalized.activeTerminalId),
  });
}

function moveThreadTerminalToNewGroup(
  state: ThreadTerminalState,
  terminalId: string,
  targetGroupIndex: number,
): ThreadTerminalState {
  return moveThreadTerminalToNewGroupForPanel(state, "bottom", terminalId, targetGroupIndex);
}

export function selectThreadTerminalState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
): ThreadTerminalState {
  if (threadId.length === 0) {
    return getDefaultThreadTerminalState();
  }
  const threadState = terminalStateByThreadId[threadId];
  return threadState
    ? getCachedNormalizedThreadTerminalState(threadState)
    : getDefaultThreadTerminalState();
}

export function selectThreadTerminalPanelState(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  placement: TerminalPanelPlacement,
): ThreadTerminalState {
  const threadState = normalizeThreadTerminalState(
    selectThreadTerminalState(terminalStateByThreadId, threadId),
  );
  const panelState = threadState.terminalPanelStateByPlacement[placement];
  return {
    ...threadState,
    terminalOpen: panelState.terminalOpen,
    terminalHeight: panelState.terminalHeight,
    terminalIds: panelState.terminalIds,
    activeTerminalId: panelState.activeTerminalId,
    terminalGroups: panelState.terminalGroups,
    activeTerminalGroupId: panelState.activeTerminalGroupId,
    splitRatiosByGroupId: panelState.splitRatiosByGroupId,
  };
}

function updateTerminalStateByThreadId(
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>,
  threadId: ThreadId,
  updater: (state: ThreadTerminalState) => ThreadTerminalState,
): Record<ThreadId, ThreadTerminalState> {
  if (threadId.length === 0) {
    return terminalStateByThreadId;
  }

  const current = selectThreadTerminalState(terminalStateByThreadId, threadId);
  const next = updater(current);
  if (next === current) {
    return terminalStateByThreadId;
  }

  if (isDefaultThreadTerminalState(next)) {
    if (terminalStateByThreadId[threadId] === undefined) {
      return terminalStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = terminalStateByThreadId;
    return rest as Record<ThreadId, ThreadTerminalState>;
  }

  return {
    ...terminalStateByThreadId,
    [threadId]: next,
  };
}

interface TerminalStateStoreState {
  terminalStateByThreadId: Record<ThreadId, ThreadTerminalState>;
  setTerminalOpen: (threadId: ThreadId, open: boolean) => void;
  setTerminalOpenForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    open: boolean,
  ) => void;
  setTerminalHeight: (threadId: ThreadId, height: number) => void;
  setTerminalHeightForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    height: number,
  ) => void;
  setTerminalSidebarWidth: (threadId: ThreadId, width: number) => void;
  setTerminalSidebarDensity: (threadId: ThreadId, density: "compact" | "comfortable") => void;
  splitTerminal: (threadId: ThreadId, terminalId: string) => void;
  splitTerminalForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
  ) => void;
  newTerminal: (threadId: ThreadId, terminalId: string) => void;
  newTerminalForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
  ) => void;
  newBackgroundTerminal: (threadId: ThreadId, terminalId: string) => void;
  newBackgroundTerminalForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
  ) => void;
  setActiveTerminal: (threadId: ThreadId, terminalId: string) => void;
  setActiveTerminalForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
  ) => void;
  moveTerminal: (
    threadId: ThreadId,
    terminalId: string,
    targetGroupId: string,
    targetIndex: number,
  ) => void;
  moveTerminalForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
    targetGroupId: string,
    targetIndex: number,
  ) => void;
  moveTerminalToNewGroup: (
    threadId: ThreadId,
    terminalId: string,
    targetGroupIndex: number,
  ) => void;
  moveTerminalToNewGroupForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    terminalId: string,
    targetGroupIndex: number,
  ) => void;
  renameTerminal: (threadId: ThreadId, terminalId: string, title: string) => void;
  setTerminalAutoTitle: (threadId: ThreadId, terminalId: string, title: string | null) => void;
  setTerminalIcon: (threadId: ThreadId, terminalId: string, icon: TerminalIconName | null) => void;
  setTerminalColor: (
    threadId: ThreadId,
    terminalId: string,
    color: TerminalColorName | null,
  ) => void;
  setTerminalGroupSplitRatios: (threadId: ThreadId, groupId: string, ratios: number[]) => void;
  setTerminalGroupSplitRatiosForPanel: (
    threadId: ThreadId,
    placement: TerminalPanelPlacement,
    groupId: string,
    ratios: number[],
  ) => void;
  closeTerminal: (threadId: ThreadId, terminalId: string) => void;
  setTerminalActivity: (
    threadId: ThreadId,
    terminalId: string,
    hasRunningSubprocess: boolean,
  ) => void;
  clearTerminalState: (threadId: ThreadId) => void;
  removeTerminalState: (threadId: ThreadId) => void;
  removeOrphanedTerminalStates: (activeThreadIds: Set<ThreadId>) => void;
}

export const useTerminalStateStore = create<TerminalStateStoreState>()(
  persist(
    (set) => {
      const updateTerminal = (
        threadId: ThreadId,
        updater: (state: ThreadTerminalState) => ThreadTerminalState,
      ) => {
        set((state) => {
          const nextTerminalStateByThreadId = updateTerminalStateByThreadId(
            state.terminalStateByThreadId,
            threadId,
            updater,
          );
          if (nextTerminalStateByThreadId === state.terminalStateByThreadId) {
            return state;
          }
          return {
            terminalStateByThreadId: nextTerminalStateByThreadId,
          };
        });
      };

      return {
        terminalStateByThreadId: {},
        setTerminalOpen: (threadId, open) =>
          updateTerminal(threadId, (state) => setThreadTerminalOpen(state, open)),
        setTerminalOpenForPanel: (threadId, placement, open) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalOpenForPanel(state, placement, open),
          ),
        setTerminalHeight: (threadId, height) =>
          updateTerminal(threadId, (state) => setThreadTerminalHeight(state, height)),
        setTerminalHeightForPanel: (threadId, placement, height) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalHeightForPanel(state, placement, height),
          ),
        setTerminalSidebarWidth: (threadId, width) =>
          updateTerminal(threadId, (state) => setThreadTerminalSidebarWidth(state, width)),
        setTerminalSidebarDensity: (threadId, density) =>
          updateTerminal(threadId, (state) => setThreadTerminalSidebarDensity(state, density)),
        splitTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => splitThreadTerminal(state, terminalId)),
        splitTerminalForPanel: (threadId, placement, terminalId) =>
          updateTerminal(threadId, (state) =>
            splitThreadTerminalForPanel(state, placement, terminalId),
          ),
        newTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => newThreadTerminal(state, terminalId)),
        newTerminalForPanel: (threadId, placement, terminalId) =>
          updateTerminal(threadId, (state) =>
            newThreadTerminalForPanel(state, placement, terminalId),
          ),
        newBackgroundTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) =>
            upsertTerminalIntoGroupsForPanel(state, "bottom", terminalId, "new", {
              terminalOpen: normalizeThreadTerminalState(state).terminalOpen,
            }),
          ),
        newBackgroundTerminalForPanel: (threadId, placement, terminalId) =>
          updateTerminal(threadId, (state) =>
            upsertTerminalIntoGroupsForPanel(state, placement, terminalId, "new", {
              terminalOpen:
                normalizeThreadTerminalState(state).terminalPanelStateByPlacement[placement]
                  .terminalOpen,
            }),
          ),
        setActiveTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => setThreadActiveTerminal(state, terminalId)),
        setActiveTerminalForPanel: (threadId, placement, terminalId) =>
          updateTerminal(threadId, (state) =>
            setThreadActiveTerminalForPanel(state, placement, terminalId),
          ),
        moveTerminal: (threadId, terminalId, targetGroupId, targetIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminal(state, terminalId, targetGroupId, targetIndex),
          ),
        moveTerminalForPanel: (threadId, placement, terminalId, targetGroupId, targetIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminalForPanel(state, placement, terminalId, targetGroupId, targetIndex),
          ),
        moveTerminalToNewGroup: (threadId, terminalId, targetGroupIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminalToNewGroup(state, terminalId, targetGroupIndex),
          ),
        moveTerminalToNewGroupForPanel: (threadId, placement, terminalId, targetGroupIndex) =>
          updateTerminal(threadId, (state) =>
            moveThreadTerminalToNewGroupForPanel(state, placement, terminalId, targetGroupIndex),
          ),
        renameTerminal: (threadId, terminalId, title) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalCustomTitle(state, terminalId, title),
          ),
        setTerminalAutoTitle: (threadId, terminalId, title) =>
          updateTerminal(threadId, (state) => setThreadTerminalAutoTitle(state, terminalId, title)),
        setTerminalIcon: (threadId, terminalId, icon) =>
          updateTerminal(threadId, (state) => setThreadTerminalIcon(state, terminalId, icon)),
        setTerminalColor: (threadId, terminalId, color) =>
          updateTerminal(threadId, (state) => setThreadTerminalColor(state, terminalId, color)),
        setTerminalGroupSplitRatios: (threadId, groupId, ratios) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalGroupSplitRatios(state, groupId, ratios),
          ),
        setTerminalGroupSplitRatiosForPanel: (threadId, placement, groupId, ratios) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalGroupSplitRatiosForPanel(state, placement, groupId, ratios),
          ),
        closeTerminal: (threadId, terminalId) =>
          updateTerminal(threadId, (state) => closeThreadTerminal(state, terminalId)),
        setTerminalActivity: (threadId, terminalId, hasRunningSubprocess) =>
          updateTerminal(threadId, (state) =>
            setThreadTerminalActivity(state, terminalId, hasRunningSubprocess),
          ),
        clearTerminalState: (threadId) =>
          updateTerminal(threadId, () => createDefaultThreadTerminalState()),
        removeTerminalState: (threadId) =>
          set((state) => {
            if (state.terminalStateByThreadId[threadId] === undefined) {
              return state;
            }
            const next = { ...state.terminalStateByThreadId };
            delete next[threadId];
            return { terminalStateByThreadId: next };
          }),
        removeOrphanedTerminalStates: (activeThreadIds) =>
          set((state) => {
            const orphanedIds = Object.keys(state.terminalStateByThreadId).filter(
              (id) => !activeThreadIds.has(id as ThreadId),
            );
            if (orphanedIds.length === 0) return state;
            const next = { ...state.terminalStateByThreadId };
            for (const id of orphanedIds) {
              delete next[id as ThreadId];
            }
            return { terminalStateByThreadId: next };
          }),
      };
    },
    {
      name: TERMINAL_STATE_STORAGE_KEY,
      version: 7,
      storage: createJSONStorage(createTerminalStateStorage),
      migrate: (persistedState) => {
        const candidate = persistedState as {
          terminalStateByThreadId?: Record<ThreadId, Partial<ThreadTerminalState>>;
        } | null;
        if (!candidate?.terminalStateByThreadId) {
          return { terminalStateByThreadId: {} };
        }
        const terminalStateByThreadId = Object.fromEntries(
          Object.entries(candidate.terminalStateByThreadId).map(([threadId, threadState]) => [
            threadId,
            normalizeThreadTerminalState({
              ...createDefaultThreadTerminalState(),
              ...(threadState as Partial<ThreadTerminalState>),
            }),
          ]),
        ) as Record<ThreadId, ThreadTerminalState>;
        return { terminalStateByThreadId };
      },
      partialize: (state) => ({
        terminalStateByThreadId: state.terminalStateByThreadId,
      }),
    },
  ),
);

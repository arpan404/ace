import { SearchQuery } from "@codemirror/search";
import { EditorState, type Text } from "@codemirror/state";

const WORKSPACE_FIND_MAX_MATCH_COUNT = 1_000;
const WORKSPACE_FIND_MAX_SEED_LENGTH = 200;

export interface WorkspaceFindState {
  readonly caseSensitive: boolean;
  readonly regexp: boolean;
  readonly replace: string;
  readonly search: string;
  readonly wholeWord: boolean;
}

export interface WorkspaceFindMatchSummary {
  readonly capped: boolean;
  readonly count: number;
}

export interface WorkspaceFindSeedInput {
  readonly currentWord?: string | null;
  readonly selectedText?: string | null;
}

export const EMPTY_WORKSPACE_FIND_STATE: WorkspaceFindState = {
  caseSensitive: false,
  regexp: false,
  replace: "",
  search: "",
  wholeWord: false,
};

function trimSeed(value: string | null | undefined): string {
  const normalized = value?.replace(/\s+/gu, " ").trim() ?? "";
  if (normalized.length <= WORKSPACE_FIND_MAX_SEED_LENGTH) {
    return normalized;
  }
  return "";
}

export function resolveWorkspaceFindSeed(input: WorkspaceFindSeedInput): string {
  const selectedText = trimSeed(input.selectedText);
  if (selectedText.length > 0) {
    return selectedText;
  }
  return trimSeed(input.currentWord);
}

export function createWorkspaceFindQuery(state: WorkspaceFindState): SearchQuery {
  return new SearchQuery({
    caseSensitive: state.caseSensitive,
    literal: !state.regexp,
    regexp: state.regexp,
    replace: state.replace,
    search: state.search,
    wholeWord: state.wholeWord,
  });
}

function toEditorState(doc: EditorState | Text | string): EditorState | Text {
  return typeof doc === "string" ? EditorState.create({ doc }) : doc;
}

export function countWorkspaceFindMatches(
  doc: EditorState | Text | string,
  query: SearchQuery,
  limit = WORKSPACE_FIND_MAX_MATCH_COUNT,
): WorkspaceFindMatchSummary {
  if (!query.valid || limit <= 0) {
    return { capped: false, count: 0 };
  }

  const cursor = query.getCursor(toEditorState(doc));
  let count = 0;
  while (count < limit) {
    const next = cursor.next();
    if (next.done) {
      return { capped: false, count };
    }
    count += 1;
  }

  return { capped: !cursor.next().done, count };
}

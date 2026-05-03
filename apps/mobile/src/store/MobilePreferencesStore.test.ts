import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CLIENT_SETTINGS } from "@ace/contracts/settings";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  mergeMobilePreferencesState,
  useMobilePreferencesStore,
  type MobilePreferencesState,
} from "./MobilePreferencesStore";

function makeCurrentState(): MobilePreferencesState {
  const state = useMobilePreferencesStore.getInitialState();
  return {
    ...state,
    browserSearchEngine: DEFAULT_CLIENT_SETTINGS.browserSearchEngine,
    confirmThreadArchive: DEFAULT_CLIENT_SETTINGS.confirmThreadArchive,
    confirmThreadDelete: DEFAULT_CLIENT_SETTINGS.confirmThreadDelete,
    dismissedThreadErrorKeysById: {},
    diffWordWrap: DEFAULT_CLIENT_SETTINGS.diffWordWrap,
    editorLineNumbers: DEFAULT_CLIENT_SETTINGS.editorLineNumbers,
    editorRenderWhitespace: DEFAULT_CLIENT_SETTINGS.editorRenderWhitespace,
    editorSuggestions: DEFAULT_CLIENT_SETTINGS.editorSuggestions,
    editorWordWrap: DEFAULT_CLIENT_SETTINGS.editorWordWrap,
    sidebarProjectSortOrder: DEFAULT_CLIENT_SETTINGS.sidebarProjectSortOrder,
    sidebarThreadSortOrder: DEFAULT_CLIENT_SETTINGS.sidebarThreadSortOrder,
    timestampFormat: DEFAULT_CLIENT_SETTINGS.timestampFormat,
  };
}

describe("MobilePreferencesStore", () => {
  beforeEach(() => {
    useMobilePreferencesStore.setState(makeCurrentState(), true);
  });

  it("merges every valid persisted preference independently", () => {
    const current = makeCurrentState();
    const merged = mergeMobilePreferencesState(
      {
        browserSearchEngine: "brave",
        confirmThreadArchive: true,
        confirmThreadDelete: false,
        dismissedThreadErrorKeysById: { "thread-a": "error-key" },
        diffWordWrap: true,
        editorLineNumbers: "relative",
        editorRenderWhitespace: true,
        editorSuggestions: true,
        editorWordWrap: true,
        sidebarProjectSortOrder: "manual",
        sidebarThreadSortOrder: "last_user_message",
        timestampFormat: "24-hour",
      },
      current,
    );

    expect(merged).toMatchObject({
      browserSearchEngine: "brave",
      confirmThreadArchive: true,
      confirmThreadDelete: false,
      dismissedThreadErrorKeysById: { "thread-a": "error-key" },
      diffWordWrap: true,
      editorLineNumbers: "relative",
      editorRenderWhitespace: true,
      editorSuggestions: true,
      editorWordWrap: true,
      sidebarProjectSortOrder: "manual",
      sidebarThreadSortOrder: "last_user_message",
      timestampFormat: "24-hour",
    });
    expect(merged.setTimestampFormat).toBe(current.setTimestampFormat);
  });

  it("falls back per field when persisted values are invalid", () => {
    const current = {
      ...makeCurrentState(),
      browserSearchEngine: "duckduckgo" as const,
      editorLineNumbers: "on" as const,
      editorWordWrap: false,
      sidebarProjectSortOrder: "updated_at" as const,
      timestampFormat: "locale" as const,
    };

    const merged = mergeMobilePreferencesState(
      {
        browserSearchEngine: "invalid",
        editorLineNumbers: "absolute",
        editorWordWrap: true,
        dismissedThreadErrorKeysById: { "thread-a": 7 },
        sidebarProjectSortOrder: "random",
        timestampFormat: "12-hour",
      },
      current,
    );

    expect(merged.browserSearchEngine).toBe("duckduckgo");
    expect(merged.editorLineNumbers).toBe("on");
    expect(merged.editorWordWrap).toBe(true);
    expect(merged.dismissedThreadErrorKeysById).toEqual({});
    expect(merged.sidebarProjectSortOrder).toBe("updated_at");
    expect(merged.timestampFormat).toBe("12-hour");
  });

  it("updates the editor and diff preferences through setters", () => {
    const state = useMobilePreferencesStore.getState();

    state.setDiffWordWrap(true);
    state.setEditorLineNumbers("relative");
    state.setEditorRenderWhitespace(true);
    state.setEditorSuggestions(true);
    state.setEditorWordWrap(true);

    expect(useMobilePreferencesStore.getState()).toMatchObject({
      diffWordWrap: true,
      editorLineNumbers: "relative",
      editorRenderWhitespace: true,
      editorSuggestions: true,
      editorWordWrap: true,
    });
  });

  it("stores dismissed thread error keys by thread id", () => {
    const state = useMobilePreferencesStore.getState();

    state.dismissThreadError("thread-a", "error-key");

    expect(useMobilePreferencesStore.getState().dismissedThreadErrorKeysById).toEqual({
      "thread-a": "error-key",
    });
  });
});

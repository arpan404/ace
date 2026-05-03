import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  DEFAULT_BROWSER_SEARCH_ENGINE,
  DEFAULT_CLIENT_SETTINGS,
  type BrowserSearchEngine,
  type EditorLineNumbers,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  type TimestampFormat,
} from "@ace/contracts/settings";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

const MOBILE_PREFERENCES_STORAGE_KEY = "ace-mobile-preferences-v1";

export interface MobilePreferencesState {
  readonly browserSearchEngine: BrowserSearchEngine;
  readonly confirmThreadArchive: boolean;
  readonly confirmThreadDelete: boolean;
  readonly dismissedThreadErrorKeysById: Readonly<Record<string, string>>;
  readonly diffWordWrap: boolean;
  readonly editorLineNumbers: EditorLineNumbers;
  readonly editorRenderWhitespace: boolean;
  readonly editorSuggestions: boolean;
  readonly editorWordWrap: boolean;
  readonly sidebarProjectSortOrder: SidebarProjectSortOrder;
  readonly sidebarThreadSortOrder: SidebarThreadSortOrder;
  readonly timestampFormat: TimestampFormat;
  readonly setBrowserSearchEngine: (engine: BrowserSearchEngine) => void;
  readonly setConfirmThreadArchive: (enabled: boolean) => void;
  readonly setConfirmThreadDelete: (enabled: boolean) => void;
  readonly dismissThreadError: (threadId: string, errorKey: string) => void;
  readonly setDiffWordWrap: (enabled: boolean) => void;
  readonly setEditorLineNumbers: (lineNumbers: EditorLineNumbers) => void;
  readonly setEditorRenderWhitespace: (enabled: boolean) => void;
  readonly setEditorSuggestions: (enabled: boolean) => void;
  readonly setEditorWordWrap: (enabled: boolean) => void;
  readonly setSidebarProjectSortOrder: (sortOrder: SidebarProjectSortOrder) => void;
  readonly setSidebarThreadSortOrder: (sortOrder: SidebarThreadSortOrder) => void;
  readonly setTimestampFormat: (format: TimestampFormat) => void;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isBrowserSearchEngine(value: unknown): value is BrowserSearchEngine {
  return value === "duckduckgo" || value === "google" || value === "brave" || value === "startpage";
}

function isEditorLineNumbers(value: unknown): value is EditorLineNumbers {
  return value === "off" || value === "on" || value === "relative";
}

function isSidebarProjectSortOrder(value: unknown): value is SidebarProjectSortOrder {
  return (
    value === "updated_at" ||
    value === "last_user_message" ||
    value === "created_at" ||
    value === "manual"
  );
}

function isSidebarThreadSortOrder(value: unknown): value is SidebarThreadSortOrder {
  return value === "updated_at" || value === "created_at" || value === "last_user_message";
}

function isTimestampFormat(value: unknown): value is TimestampFormat {
  return value === "locale" || value === "12-hour" || value === "24-hour";
}

export function mergeMobilePreferencesState(
  persisted: unknown,
  current: MobilePreferencesState,
): MobilePreferencesState {
  if (typeof persisted !== "object" || persisted === null) {
    return current;
  }
  return {
    ...current,
    browserSearchEngine:
      "browserSearchEngine" in persisted && isBrowserSearchEngine(persisted.browserSearchEngine)
        ? persisted.browserSearchEngine
        : current.browserSearchEngine,
    confirmThreadArchive:
      "confirmThreadArchive" in persisted && typeof persisted.confirmThreadArchive === "boolean"
        ? persisted.confirmThreadArchive
        : current.confirmThreadArchive,
    confirmThreadDelete:
      "confirmThreadDelete" in persisted && typeof persisted.confirmThreadDelete === "boolean"
        ? persisted.confirmThreadDelete
        : current.confirmThreadDelete,
    dismissedThreadErrorKeysById:
      "dismissedThreadErrorKeysById" in persisted &&
      isStringRecord(persisted.dismissedThreadErrorKeysById)
        ? persisted.dismissedThreadErrorKeysById
        : current.dismissedThreadErrorKeysById,
    diffWordWrap:
      "diffWordWrap" in persisted && typeof persisted.diffWordWrap === "boolean"
        ? persisted.diffWordWrap
        : current.diffWordWrap,
    editorLineNumbers:
      "editorLineNumbers" in persisted && isEditorLineNumbers(persisted.editorLineNumbers)
        ? persisted.editorLineNumbers
        : current.editorLineNumbers,
    editorRenderWhitespace:
      "editorRenderWhitespace" in persisted && typeof persisted.editorRenderWhitespace === "boolean"
        ? persisted.editorRenderWhitespace
        : current.editorRenderWhitespace,
    editorSuggestions:
      "editorSuggestions" in persisted && typeof persisted.editorSuggestions === "boolean"
        ? persisted.editorSuggestions
        : current.editorSuggestions,
    editorWordWrap:
      "editorWordWrap" in persisted && typeof persisted.editorWordWrap === "boolean"
        ? persisted.editorWordWrap
        : current.editorWordWrap,
    sidebarProjectSortOrder:
      "sidebarProjectSortOrder" in persisted &&
      isSidebarProjectSortOrder(persisted.sidebarProjectSortOrder)
        ? persisted.sidebarProjectSortOrder
        : current.sidebarProjectSortOrder,
    sidebarThreadSortOrder:
      "sidebarThreadSortOrder" in persisted &&
      isSidebarThreadSortOrder(persisted.sidebarThreadSortOrder)
        ? persisted.sidebarThreadSortOrder
        : current.sidebarThreadSortOrder,
    timestampFormat:
      "timestampFormat" in persisted && isTimestampFormat(persisted.timestampFormat)
        ? persisted.timestampFormat
        : current.timestampFormat,
  };
}

export const useMobilePreferencesStore = create<MobilePreferencesState>()(
  persist(
    (set) => ({
      browserSearchEngine: DEFAULT_BROWSER_SEARCH_ENGINE,
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
      setBrowserSearchEngine: (browserSearchEngine) => set({ browserSearchEngine }),
      setConfirmThreadArchive: (confirmThreadArchive) => set({ confirmThreadArchive }),
      setConfirmThreadDelete: (confirmThreadDelete) => set({ confirmThreadDelete }),
      dismissThreadError: (threadId, errorKey) =>
        set((state) => ({
          dismissedThreadErrorKeysById: {
            ...state.dismissedThreadErrorKeysById,
            [threadId]: errorKey,
          },
        })),
      setDiffWordWrap: (diffWordWrap) => set({ diffWordWrap }),
      setEditorLineNumbers: (editorLineNumbers) => set({ editorLineNumbers }),
      setEditorRenderWhitespace: (editorRenderWhitespace) => set({ editorRenderWhitespace }),
      setEditorSuggestions: (editorSuggestions) => set({ editorSuggestions }),
      setEditorWordWrap: (editorWordWrap) => set({ editorWordWrap }),
      setSidebarProjectSortOrder: (sidebarProjectSortOrder) => set({ sidebarProjectSortOrder }),
      setSidebarThreadSortOrder: (sidebarThreadSortOrder) => set({ sidebarThreadSortOrder }),
      setTimestampFormat: (timestampFormat) => set({ timestampFormat }),
    }),
    {
      name: MOBILE_PREFERENCES_STORAGE_KEY,
      storage: createJSONStorage(() => AsyncStorage),
      merge: mergeMobilePreferencesState,
      partialize: (state) => ({
        browserSearchEngine: state.browserSearchEngine,
        confirmThreadArchive: state.confirmThreadArchive,
        confirmThreadDelete: state.confirmThreadDelete,
        dismissedThreadErrorKeysById: state.dismissedThreadErrorKeysById,
        diffWordWrap: state.diffWordWrap,
        editorLineNumbers: state.editorLineNumbers,
        editorRenderWhitespace: state.editorRenderWhitespace,
        editorSuggestions: state.editorSuggestions,
        editorWordWrap: state.editorWordWrap,
        sidebarProjectSortOrder: state.sidebarProjectSortOrder,
        sidebarThreadSortOrder: state.sidebarThreadSortOrder,
        timestampFormat: state.timestampFormat,
      }),
    },
  ),
);

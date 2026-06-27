import { EDITORS, EditorId, NativeApi } from "@ace/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";

const LAST_EDITOR_KEY = "ace:last-editor:v1";
const LEGACY_LAST_EDITOR_KEY = "ace:last-editor";

function readStoredPreferredEditor(): EditorId | null {
  const storedEditor = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (storedEditor) {
    return storedEditor;
  }
  const legacyStoredEditor = getLocalStorageItem(LEGACY_LAST_EDITOR_KEY, EditorId);
  if (legacyStoredEditor) {
    setLocalStorageItem(LAST_EDITOR_KEY, legacyStoredEditor, EditorId);
  }
  return legacyStoredEditor;
}

function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(
    LAST_EDITOR_KEY,
    readStoredPreferredEditor(),
    EditorId,
  );

  const effectiveEditor =
    lastEditor && availableEditors.includes(lastEditor)
      ? lastEditor
      : (EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null);

  return [effectiveEditor, setLastEditor] as const;
}

function resolveAndPersistPreferredEditor(availableEditors: readonly EditorId[]): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = readStoredPreferredEditor();
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export async function openInPreferredEditor(api: NativeApi, targetPath: string): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) throw new Error("No available editors found.");
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Markdown from "react-native-markdown-display";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChevronLeft,
  Code2,
  Crosshair,
  Eye,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  ListChecks,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react-native";
import {
  buildWorkspacePreviewHttpUrl,
  detectWorkspacePreviewKind,
  type WorkspacePreviewKind,
} from "@ace/shared/workspaceFilePreview";
import type {
  ProjectEntry,
  ProjectReadFileResult,
  WorkspaceEditorCompletionItem,
  WorkspaceEditorDiagnostic,
  WorkspaceEditorLocation,
} from "@ace/contracts";
import { Layout, Radius, withAlpha } from "../../src/design/system";
import { useTheme } from "../../src/design/ThemeContext";
import { EmptyState, Panel, ScreenBackdrop, SectionTitle } from "../../src/design/primitives";
import { connectionManager, type ManagedConnection } from "../../src/rpc/ConnectionManager";
import { useHostStore } from "../../src/store/HostStore";
import { useMobilePreferencesStore } from "../../src/store/MobilePreferencesStore";

const MAX_VISIBLE_ENTRIES = 160;

interface SaveConflictState {
  readonly currentContents: string;
  readonly currentVersion?: string;
  readonly expectedVersion?: string;
  readonly localContents: string;
  readonly relativePath: string;
}

type CodeInsightAction = "diagnostics" | "complete" | "definition" | "references";
type FileViewMode = "edit" | "preview";

interface CodeInsightState {
  readonly completions: ReadonlyArray<WorkspaceEditorCompletionItem>;
  readonly diagnostics: ReadonlyArray<WorkspaceEditorDiagnostic>;
  readonly locations: ReadonlyArray<WorkspaceEditorLocation>;
  readonly message: string | null;
}

function paramValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? path;
}

function compareEntries(left: ProjectEntry, right: ProjectEntry): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.path.localeCompare(right.path);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function offsetToLineColumn(contents: string, offset: number): { column: number; line: number } {
  const clampedOffset = Math.max(0, Math.min(offset, contents.length));
  let line = 0;
  let column = 0;
  for (let index = 0; index < clampedOffset; index += 1) {
    if (contents[index] === "\n") {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function formatWhitespacePreview(contents: string): string {
  return contents.replace(/ /gu, ".").replace(/\t/gu, ">\t").split("\n").slice(0, 12).join("\n");
}

function readConflictField(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return Reflect.get(error, key);
}

function parseSaveConflictState(
  error: unknown,
  input: { contents: string; relativePath: string },
): SaveConflictState | null {
  const conflict = readConflictField(error, "conflict");
  const currentContents = readConflictField(error, "currentContents");
  if (conflict !== true || typeof currentContents !== "string") {
    return null;
  }
  const currentVersion = readConflictField(error, "currentVersion");
  const expectedVersion = readConflictField(error, "expectedVersion");
  return {
    currentContents,
    localContents: input.contents,
    relativePath: input.relativePath,
    ...(typeof currentVersion === "string" ? { currentVersion } : {}),
    ...(typeof expectedVersion === "string" ? { expectedVersion } : {}),
  };
}

export default function ProjectFilesScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const hosts = useHostStore((state) => state.hosts);
  const editorLineNumbers = useMobilePreferencesStore((state) => state.editorLineNumbers);
  const editorRenderWhitespace = useMobilePreferencesStore((state) => state.editorRenderWhitespace);
  const editorSuggestions = useMobilePreferencesStore((state) => state.editorSuggestions);
  const editorWordWrap = useMobilePreferencesStore((state) => state.editorWordWrap);
  const params = useLocalSearchParams<{
    projectId?: string;
    hostId?: string;
    cwd?: string;
    title?: string;
    hostName?: string;
  }>();

  const hostId = paramValue(params.hostId);
  const cwd = paramValue(params.cwd);
  const title = paramValue(params.title) || "Project files";
  const hostName = paramValue(params.hostName) || "Host";

  const [connection, setConnection] = useState<ManagedConnection | null>(null);
  const [entries, setEntries] = useState<ReadonlyArray<ProjectEntry>>([]);
  const [loadingTree, setLoadingTree] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchEntries, setSearchEntries] = useState<ReadonlyArray<ProjectEntry>>([]);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [selectedFile, setSelectedFile] = useState<ProjectReadFileResult | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<ProjectEntry | null>(null);
  const [selectedPreviewEntry, setSelectedPreviewEntry] = useState<ProjectEntry | null>(null);
  const [draft, setDraft] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutatingEntry, setMutatingEntry] = useState(false);
  const [failedFileEntry, setFailedFileEntry] = useState<ProjectEntry | null>(null);
  const [fileViewMode, setFileViewMode] = useState<FileViewMode>("edit");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [newEntryPath, setNewEntryPath] = useState("");
  const [renamePath, setRenamePath] = useState("");
  const [directoryRenamePath, setDirectoryRenamePath] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [saveConflict, setSaveConflict] = useState<SaveConflictState | null>(null);
  const [selectionOffset, setSelectionOffset] = useState(0);
  const [codeInsight, setCodeInsight] = useState<CodeInsightState | null>(null);
  const [codeInsightLoading, setCodeInsightLoading] = useState<CodeInsightAction | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    setConnection(
      connectionManager.getConnections().find((candidate) => candidate.host.id === hostId) ?? null,
    );
    return connectionManager.onStatusChange((connections) => {
      setConnection(connections.find((candidate) => candidate.host.id === hostId) ?? null);
    });
  }, [hostId]);

  const activeHost = useMemo(
    () => hosts.find((host) => host.id === hostId) ?? connection?.host ?? null,
    [connection?.host, hostId, hosts],
  );
  const hostOffline =
    Boolean(activeHost) && (!connection || connection.status.kind !== "connected");
  const connectionError =
    connection?.status.kind === "disconnected" && connection.status.error
      ? connection.status.error
      : null;

  const reconnectHost = useCallback(async () => {
    if (!activeHost || reconnecting) {
      return;
    }

    setReconnecting(true);
    setReconnectError(null);
    setTreeError(null);
    try {
      const client = await connectionManager.connect(activeHost, { forceReconnect: true });
      await client.server.getConfig();
      if (cwd.length > 0) {
        const result = await client.projects.listTree({ cwd });
        setEntries(result.entries.toSorted(compareEntries));
        setTreeError(
          result.truncated
            ? "File list was truncated by the host. Use search to narrow the workspace."
            : null,
        );
      }
    } catch (cause) {
      setReconnectError(errorMessage(cause));
    } finally {
      setReconnecting(false);
      setLoadingTree(false);
    }
  }, [activeHost, cwd, reconnecting]);

  const refreshTree = useCallback(async () => {
    if (!connection || connection.status.kind !== "connected" || cwd.length === 0) {
      setLoadingTree(false);
      setEntries([]);
      setTreeError("Connect this host before browsing files.");
      return;
    }

    setLoadingTree(true);
    setTreeError(null);
    try {
      const result = await connection.client.projects.listTree({ cwd });
      setEntries(result.entries.toSorted(compareEntries));
      if (result.truncated) {
        setTreeError("File list was truncated by the host. Use search to narrow the workspace.");
      }
    } catch (cause) {
      setTreeError(errorMessage(cause));
    } finally {
      setLoadingTree(false);
    }
  }, [connection, cwd]);

  useEffect(() => {
    void refreshTree();
  }, [refreshTree]);

  useEffect(() => {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      setSearchEntries([]);
      setSearchError(null);
      setSearchTruncated(false);
      setLoadingSearch(false);
      return;
    }

    if (!connection || connection.status.kind !== "connected" || cwd.length === 0) {
      setSearchEntries([]);
      setSearchError("Connect this host before searching files.");
      setSearchTruncated(false);
      setLoadingSearch(false);
      return;
    }

    let cancelled = false;
    setLoadingSearch(true);
    setSearchError(null);
    const timer = setTimeout(() => {
      connection.client.projects
        .searchEntries({
          cwd,
          query: trimmedQuery,
          limit: MAX_VISIBLE_ENTRIES,
        })
        .then((result) => {
          if (cancelled) {
            return;
          }
          setSearchEntries(result.entries.toSorted(compareEntries));
          setSearchTruncated(result.truncated);
        })
        .catch((cause: unknown) => {
          if (cancelled) {
            return;
          }
          setSearchEntries([]);
          setSearchTruncated(false);
          setSearchError(errorMessage(cause));
        })
        .finally(() => {
          if (!cancelled) {
            setLoadingSearch(false);
          }
        });
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connection, cwd, query]);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length > 0) {
      return searchEntries.slice(0, MAX_VISIBLE_ENTRIES);
    }
    const filtered =
      normalizedQuery.length === 0
        ? entries
        : entries.filter((entry) => entry.path.toLowerCase().includes(normalizedQuery));
    return filtered.slice(0, MAX_VISIBLE_ENTRIES);
  }, [entries, query, searchEntries]);

  const openFile = useCallback(
    async (entry: ProjectEntry) => {
      if (entry.kind !== "file" || !connection || connection.status.kind !== "connected") {
        return;
      }

      setLoadingFile(true);
      setFileError(null);
      try {
        const result = await connection.client.projects.readFile({
          cwd,
          relativePath: entry.path,
        });
        setSelectedFile(result);
        setSelectedDirectory(null);
        setSelectedPreviewEntry(null);
        setDraft(result.contents);
        setRenamePath(result.relativePath);
        setDirectoryRenamePath("");
        setSaveConflict(null);
        setSelectionOffset(0);
        setCodeInsight(null);
        setFailedFileEntry(null);
        setFileViewMode(
          detectWorkspacePreviewKind(result.relativePath) === "markdown" ? "preview" : "edit",
        );
        setPreviewError(null);
      } catch (cause) {
        setFileError(errorMessage(cause));
        setFailedFileEntry(entry);
      } finally {
        setLoadingFile(false);
      }
    },
    [connection, cwd],
  );

  const selectDirectory = useCallback((entry: ProjectEntry) => {
    if (entry.kind !== "directory") {
      return;
    }
    setSelectedDirectory(entry);
    setSelectedFile(null);
    setSelectedPreviewEntry(null);
    setDraft("");
    setRenamePath("");
    setDirectoryRenamePath(entry.path);
    setFileError(null);
    setSaveConflict(null);
    setSelectionOffset(0);
    setCodeInsight(null);
    setFileViewMode("edit");
    setPreviewError(null);
  }, []);

  const openPreviewEntry = useCallback((entry: ProjectEntry, kind: WorkspacePreviewKind) => {
    setSelectedPreviewEntry(entry);
    setSelectedFile(null);
    setSelectedDirectory(null);
    setDraft("");
    setRenamePath("");
    setDirectoryRenamePath("");
    setFileError(null);
    setSaveConflict(null);
    setSelectionOffset(0);
    setCodeInsight(null);
    setFileViewMode("preview");
    setPreviewError(kind === "image" || kind === "video" ? null : "Preview unavailable.");
  }, []);

  const confirmDiscardingDraft = useCallback(
    (onDiscard: () => void) => {
      if (!selectedFile || draft === selectedFile.contents) {
        onDiscard();
        return;
      }

      Alert.alert(
        "Discard unsaved edits?",
        `${selectedFile.relativePath} has local edits that have not been saved.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: onDiscard,
          },
        ],
      );
    },
    [draft, selectedFile],
  );

  const openEntry = useCallback(
    (entry: ProjectEntry) => {
      if (entry.kind === "file") {
        if (selectedFile?.relativePath === entry.path) {
          return;
        }
        const previewKind = detectWorkspacePreviewKind(entry.path);
        if (previewKind === "image" || previewKind === "video") {
          if (selectedPreviewEntry?.path === entry.path) {
            return;
          }
          confirmDiscardingDraft(() => openPreviewEntry(entry, previewKind));
          return;
        }
        confirmDiscardingDraft(() => {
          void openFile(entry);
        });
        return;
      }

      if (selectedDirectory?.path === entry.path) {
        return;
      }
      confirmDiscardingDraft(() => selectDirectory(entry));
    },
    [
      confirmDiscardingDraft,
      openFile,
      openPreviewEntry,
      selectDirectory,
      selectedDirectory?.path,
      selectedFile,
      selectedPreviewEntry?.path,
    ],
  );

  const runCodeInsight = useCallback(
    async (action: CodeInsightAction) => {
      if (!selectedFile || !connection || connection.status.kind !== "connected") {
        return;
      }

      const position = offsetToLineColumn(draft, selectionOffset);
      const input = {
        cwd,
        relativePath: selectedFile.relativePath,
        contents: draft,
      };

      setCodeInsightLoading(action);
      setFileError(null);
      try {
        if (action === "diagnostics") {
          const result = await connection.client.workspaceEditor.syncBuffer(input);
          setCodeInsight({
            diagnostics: result.diagnostics,
            completions: [],
            locations: [],
            message:
              result.diagnostics.length === 0 ? "No diagnostics reported for this file." : null,
          });
          return;
        }

        if (action === "complete") {
          const result = await connection.client.workspaceEditor.complete({
            ...input,
            ...position,
          });
          setCodeInsight({
            diagnostics: [],
            completions: result.items,
            locations: [],
            message:
              result.items.length === 0
                ? `No completions at line ${position.line + 1}, column ${position.column + 1}.`
                : null,
          });
          return;
        }

        if (action === "definition") {
          const result = await connection.client.workspaceEditor.definition({
            ...input,
            ...position,
          });
          setCodeInsight({
            diagnostics: [],
            completions: [],
            locations: result.locations,
            message:
              result.locations.length === 0
                ? `No definition at line ${position.line + 1}, column ${position.column + 1}.`
                : null,
          });
          return;
        }

        const result = await connection.client.workspaceEditor.references({
          ...input,
          ...position,
        });
        setCodeInsight({
          diagnostics: [],
          completions: [],
          locations: result.locations,
          message:
            result.locations.length === 0
              ? `No references at line ${position.line + 1}, column ${position.column + 1}.`
              : null,
        });
      } catch (cause) {
        setCodeInsight(null);
        setFileError(errorMessage(cause));
      } finally {
        setCodeInsightLoading(null);
      }
    },
    [connection, cwd, draft, selectedFile, selectionOffset],
  );

  const saveFile = useCallback(async () => {
    if (!selectedFile || !connection || connection.status.kind !== "connected") {
      return;
    }

    setSaving(true);
    setFileError(null);
    setSaveConflict(null);
    try {
      const result = await connection.client.projects.writeFile({
        cwd,
        relativePath: selectedFile.relativePath,
        contents: draft,
        expectedVersion: selectedFile.version,
      });
      setSelectedFile({
        ...selectedFile,
        contents: draft,
        version: result.version,
      });
      await refreshTree();
    } catch (cause) {
      const conflict = parseSaveConflictState(cause, {
        contents: draft,
        relativePath: selectedFile.relativePath,
      });
      if (conflict) {
        setSaveConflict(conflict);
        return;
      }
      setFileError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [connection, cwd, draft, refreshTree, selectedFile]);

  const overwriteConflict = useCallback(async () => {
    if (!saveConflict || !selectedFile || !connection || connection.status.kind !== "connected") {
      return;
    }

    setSaving(true);
    setFileError(null);
    try {
      const result = await connection.client.projects.writeFile({
        cwd,
        relativePath: saveConflict.relativePath,
        contents: draft,
        overwrite: true,
        ...(saveConflict.currentVersion ? { expectedVersion: saveConflict.currentVersion } : {}),
      });
      setSelectedFile({
        ...selectedFile,
        contents: draft,
        relativePath: saveConflict.relativePath,
        version: result.version,
      });
      setRenamePath(saveConflict.relativePath);
      setSaveConflict(null);
      await refreshTree();
    } catch (cause) {
      setFileError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [connection, cwd, draft, refreshTree, saveConflict, selectedFile]);

  const keepDiskVersion = useCallback(() => {
    if (!saveConflict || !selectedFile) {
      return;
    }
    setSelectedFile({
      ...selectedFile,
      contents: saveConflict.currentContents,
      relativePath: saveConflict.relativePath,
      sizeBytes: saveConflict.currentContents.length,
      version: saveConflict.currentVersion ?? selectedFile.version,
    });
    setDraft(saveConflict.currentContents);
    setRenamePath(saveConflict.relativePath);
    setSaveConflict(null);
    setFileError(null);
  }, [saveConflict, selectedFile]);

  const createEntry = useCallback(
    async (kind: ProjectEntry["kind"]) => {
      if (!connection || connection.status.kind !== "connected") {
        setTreeError("Connect this host before changing files.");
        return;
      }

      const relativePath = newEntryPath.trim();
      if (relativePath.length === 0) {
        setTreeError("Enter a file or folder path first.");
        return;
      }

      setMutatingEntry(true);
      setTreeError(null);
      try {
        await connection.client.projects.createEntry({ cwd, relativePath, kind });
        setNewEntryPath("");
        await refreshTree();
        if (kind === "file") {
          await openFile({ kind: "file", path: relativePath });
        } else {
          setSelectedDirectory({ kind: "directory", path: relativePath });
          setDirectoryRenamePath(relativePath);
          setSelectedFile(null);
        }
      } catch (cause) {
        setTreeError(errorMessage(cause));
      } finally {
        setMutatingEntry(false);
      }
    },
    [connection, cwd, newEntryPath, openFile, refreshTree],
  );

  const renameSelectedDirectory = useCallback(async () => {
    if (!selectedDirectory || !connection || connection.status.kind !== "connected") {
      return;
    }

    const nextRelativePath = directoryRenamePath.trim();
    if (nextRelativePath.length === 0 || nextRelativePath === selectedDirectory.path) {
      return;
    }

    setMutatingEntry(true);
    setFileError(null);
    try {
      const result = await connection.client.projects.renameEntry({
        cwd,
        relativePath: selectedDirectory.path,
        nextRelativePath,
      });
      setSelectedDirectory({ kind: "directory", path: result.relativePath });
      setDirectoryRenamePath(result.relativePath);
      await refreshTree();
    } catch (cause) {
      setFileError(errorMessage(cause));
    } finally {
      setMutatingEntry(false);
    }
  }, [connection, cwd, directoryRenamePath, refreshTree, selectedDirectory]);

  const deleteSelectedDirectory = useCallback(() => {
    if (!selectedDirectory || !connection || connection.status.kind !== "connected") {
      return;
    }

    Alert.alert("Delete folder", `Delete ${selectedDirectory.path} and everything inside it?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setMutatingEntry(true);
          setFileError(null);
          connection.client.projects
            .deleteEntry({ cwd, relativePath: selectedDirectory.path })
            .then(async () => {
              setSelectedDirectory(null);
              setDirectoryRenamePath("");
              await refreshTree();
            })
            .catch((cause: unknown) => {
              setFileError(errorMessage(cause));
            })
            .finally(() => {
              setMutatingEntry(false);
            });
        },
      },
    ]);
  }, [connection, cwd, refreshTree, selectedDirectory]);

  const renameSelectedFile = useCallback(async () => {
    if (!selectedFile || !connection || connection.status.kind !== "connected") {
      return;
    }

    const nextRelativePath = renamePath.trim();
    if (nextRelativePath.length === 0 || nextRelativePath === selectedFile.relativePath) {
      return;
    }

    setMutatingEntry(true);
    setFileError(null);
    try {
      const result = await connection.client.projects.renameEntry({
        cwd,
        relativePath: selectedFile.relativePath,
        nextRelativePath,
      });
      await refreshTree();
      await openFile({ kind: "file", path: result.relativePath });
    } catch (cause) {
      setFileError(errorMessage(cause));
    } finally {
      setMutatingEntry(false);
    }
  }, [connection, cwd, openFile, refreshTree, renamePath, selectedFile]);

  const deleteSelectedFile = useCallback(() => {
    if (!selectedFile || !connection || connection.status.kind !== "connected") {
      return;
    }

    Alert.alert("Delete file", `Delete ${selectedFile.relativePath}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          setMutatingEntry(true);
          setFileError(null);
          connection.client.projects
            .deleteEntry({ cwd, relativePath: selectedFile.relativePath })
            .then(async () => {
              setSelectedFile(null);
              setSelectedDirectory(null);
              setDraft("");
              setRenamePath("");
              setDirectoryRenamePath("");
              await refreshTree();
            })
            .catch((cause: unknown) => {
              setFileError(errorMessage(cause));
            })
            .finally(() => {
              setMutatingEntry(false);
            });
        },
      },
    ]);
  }, [connection, cwd, refreshTree, selectedFile]);

  const isDirty = selectedFile ? draft !== selectedFile.contents : false;
  const activePreviewKind = selectedFile
    ? detectWorkspacePreviewKind(selectedFile.relativePath)
    : null;
  const canPreviewMarkdown = activePreviewKind === "markdown";
  const selectedBinaryPreviewKind = selectedPreviewEntry
    ? detectWorkspacePreviewKind(selectedPreviewEntry.path)
    : null;
  const selectedPreviewUrl =
    selectedPreviewEntry && activeHost
      ? buildWorkspacePreviewHttpUrl(activeHost.wsUrl, cwd, selectedPreviewEntry.path)
      : null;
  const cursorPosition = offsetToLineColumn(draft, selectionOffset);
  const editorLineCount = Math.max(1, draft.split("\n").length);
  const editorLongestLineLength = Math.max(1, ...draft.split("\n").map((line) => line.length));
  const editorInputMinWidth = editorWordWrap
    ? undefined
    : Math.max(260, Math.min(1600, editorLongestLineLength * 8 + 28));
  const canRename =
    !hostOffline &&
    selectedFile !== null &&
    renamePath.trim().length > 0 &&
    renamePath.trim() !== selectedFile.relativePath;
  const canRenameDirectory =
    !hostOffline &&
    selectedDirectory !== null &&
    directoryRenamePath.trim().length > 0 &&
    directoryRenamePath.trim() !== selectedDirectory.path;
  const markdownStyles = useMemo(
    () => ({
      body: {
        color: colors.foreground,
        fontSize: 14,
        lineHeight: 21,
      },
      bullet_list: {
        marginTop: 6,
        marginBottom: 6,
      },
      code_inline: {
        backgroundColor: withAlpha(colors.foreground, 0.07),
        borderRadius: 5,
        color: colors.foreground,
        fontFamily: MONO,
      },
      fence: {
        backgroundColor: colors.surfaceSecondary,
        borderColor: colors.elevatedBorder,
        borderRadius: Radius.input,
        borderWidth: 1,
        color: colors.foreground,
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 18,
        padding: 10,
      },
      heading1: {
        color: colors.foreground,
        fontSize: 24,
        fontWeight: "800" as const,
        lineHeight: 30,
        marginBottom: 10,
      },
      heading2: {
        color: colors.foreground,
        fontSize: 20,
        fontWeight: "800" as const,
        lineHeight: 26,
        marginBottom: 8,
      },
      heading3: {
        color: colors.foreground,
        fontSize: 17,
        fontWeight: "800" as const,
        lineHeight: 23,
        marginBottom: 6,
      },
      hr: {
        backgroundColor: colors.separator,
      },
      link: {
        color: colors.primary,
        fontWeight: "700" as const,
      },
      ordered_list: {
        marginTop: 6,
        marginBottom: 6,
      },
      paragraph: {
        marginTop: 0,
        marginBottom: 10,
      },
      table: {
        borderColor: colors.elevatedBorder,
      },
      tr: {
        borderColor: colors.elevatedBorder,
      },
    }),
    [colors],
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <ScreenBackdrop />
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View
          style={[
            styles.header,
            {
              paddingTop: insets.top + 10,
              backgroundColor: colors.background,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <Pressable
              onPress={() => confirmDiscardingDraft(() => router.back())}
              style={[
                styles.headerButton,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.elevatedBorder,
                  shadowColor: colors.shadow,
                },
              ]}
            >
              <ChevronLeft size={18} color={colors.foreground} strokeWidth={2.2} />
            </Pressable>
            <View style={styles.headerCopy}>
              <Text style={[styles.eyebrow, { color: colors.tertiaryLabel }]}>{hostName}</Text>
              <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
                {title}
              </Text>
              <Text style={[styles.subtitle, { color: colors.secondaryLabel }]} numberOfLines={1}>
                {selectedFile?.relativePath ??
                  selectedPreviewEntry?.path ??
                  selectedDirectory?.path ??
                  cwd}
              </Text>
            </View>
            {selectedFile ? (
              <Pressable
                onPress={() => void saveFile()}
                disabled={!isDirty || saving || hostOffline}
                style={[
                  styles.saveButton,
                  {
                    backgroundColor:
                      isDirty && !hostOffline ? colors.primary : colors.surfaceSecondary,
                    borderColor: isDirty && !hostOffline ? colors.primary : colors.elevatedBorder,
                  },
                  (!isDirty || saving || hostOffline) && styles.disabled,
                ]}
              >
                {saving ? (
                  <ActivityIndicator color={colors.primaryForeground} />
                ) : (
                  <Save
                    size={16}
                    color={isDirty && !hostOffline ? colors.primaryForeground : colors.muted}
                    strokeWidth={2.3}
                  />
                )}
              </Pressable>
            ) : null}
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{
            paddingHorizontal: Layout.pagePadding,
            paddingBottom: insets.bottom + 36,
          }}
          refreshControl={
            <RefreshControl refreshing={loadingTree} onRefresh={() => void refreshTree()} />
          }
        >
          <View
            style={[
              styles.searchShell,
              {
                backgroundColor: colors.surface,
                borderColor: colors.elevatedBorder,
              },
            ]}
          >
            <Search size={16} color={colors.tertiaryLabel} strokeWidth={2.2} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search paths"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[styles.searchInput, { color: colors.foreground }]}
            />
            {loadingSearch ? <ActivityIndicator color={colors.primary} /> : null}
          </View>

          {hostOffline ? (
            <View
              style={[
                styles.connectionRecoveryBanner,
                {
                  backgroundColor: withAlpha(colors.orange, 0.12),
                  borderColor: withAlpha(colors.orange, 0.22),
                },
              ]}
            >
              <View style={styles.connectionRecoveryCopy}>
                <Text style={[styles.connectionRecoveryTitle, { color: colors.foreground }]}>
                  Host disconnected
                </Text>
                <Text
                  style={[styles.connectionRecoveryBody, { color: colors.secondaryLabel }]}
                  numberOfLines={2}
                >
                  {connectionError ??
                    reconnectError ??
                    `Reconnect ${activeHost?.name ?? hostName} before editing files.`}
                </Text>
              </View>
              <Pressable
                disabled={reconnecting}
                onPress={() => void reconnectHost()}
                style={[
                  styles.connectionReconnectButton,
                  {
                    backgroundColor: colors.surface,
                    borderColor: colors.elevatedBorder,
                  },
                  reconnecting && styles.disabled,
                ]}
              >
                {reconnecting ? (
                  <ActivityIndicator color={colors.primary} />
                ) : (
                  <RefreshCw size={16} color={colors.primary} strokeWidth={2.3} />
                )}
                <Text style={[styles.connectionReconnectLabel, { color: colors.primary }]}>
                  Reconnect
                </Text>
              </Pressable>
            </View>
          ) : null}

          {selectedFile ? (
            <Panel style={styles.editorPanel}>
              <View style={styles.editorHeader}>
                <View style={styles.editorTitleCopy}>
                  <SectionTitle>Editor</SectionTitle>
                  <Text style={[styles.editorPath, { color: colors.foreground }]} numberOfLines={1}>
                    {selectedFile.relativePath}
                  </Text>
                </View>
                {isDirty ? (
                  <Text style={[styles.dirtyLabel, { color: colors.orange }]}>Unsaved</Text>
                ) : (
                  <Text style={[styles.dirtyLabel, { color: colors.green }]}>Saved</Text>
                )}
              </View>
              {canPreviewMarkdown ? (
                <View
                  style={[
                    styles.previewModeToggle,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Pressable
                    onPress={() => setFileViewMode("preview")}
                    style={[
                      styles.previewModeButton,
                      fileViewMode === "preview" && {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Eye
                      size={14}
                      color={fileViewMode === "preview" ? colors.primary : colors.tertiaryLabel}
                      strokeWidth={2.2}
                    />
                    <Text
                      style={[
                        styles.previewModeButtonText,
                        {
                          color:
                            fileViewMode === "preview" ? colors.foreground : colors.secondaryLabel,
                        },
                      ]}
                    >
                      Preview
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setFileViewMode("edit")}
                    style={[
                      styles.previewModeButton,
                      fileViewMode === "edit" && {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Code2
                      size={14}
                      color={fileViewMode === "edit" ? colors.primary : colors.tertiaryLabel}
                      strokeWidth={2.2}
                    />
                    <Text
                      style={[
                        styles.previewModeButtonText,
                        {
                          color:
                            fileViewMode === "edit" ? colors.foreground : colors.secondaryLabel,
                        },
                      ]}
                    >
                      Edit
                    </Text>
                  </Pressable>
                </View>
              ) : null}
              {canPreviewMarkdown && fileViewMode === "preview" ? (
                <ScrollView
                  style={[
                    styles.markdownPreviewFrame,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                  contentContainerStyle={styles.markdownPreviewContent}
                  nestedScrollEnabled
                >
                  <Markdown style={markdownStyles}>{draft}</Markdown>
                </ScrollView>
              ) : (
                <View
                  style={[
                    styles.editorInputFrame,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  {editorLineNumbers !== "off" ? (
                    <View
                      style={[styles.lineNumberGutter, { borderRightColor: colors.elevatedBorder }]}
                    >
                      {Array.from({ length: editorLineCount }, (_, index) => {
                        const line = index + 1;
                        const label =
                          editorLineNumbers === "relative"
                            ? line === cursorPosition.line + 1
                              ? String(line)
                              : String(Math.abs(line - (cursorPosition.line + 1)))
                            : String(line);
                        return (
                          <Text
                            key={line}
                            style={[
                              styles.lineNumberText,
                              {
                                color:
                                  line === cursorPosition.line + 1
                                    ? colors.primary
                                    : colors.tertiaryLabel,
                              },
                            ]}
                          >
                            {label}
                          </Text>
                        );
                      })}
                    </View>
                  ) : null}
                  <ScrollView
                    horizontal={!editorWordWrap}
                    scrollEnabled={!editorWordWrap}
                    showsHorizontalScrollIndicator={!editorWordWrap}
                    keyboardShouldPersistTaps="handled"
                    style={styles.editorScroll}
                  >
                    <TextInput
                      value={draft}
                      onChangeText={(value) => {
                        setDraft(value);
                        setCodeInsight(null);
                      }}
                      onSelectionChange={(event) => {
                        setSelectionOffset(event.nativeEvent.selection.start);
                      }}
                      multiline
                      autoCapitalize="none"
                      autoCorrect={false}
                      spellCheck={false}
                      scrollEnabled={false}
                      editable={!hostOffline}
                      style={[
                        styles.editorInput,
                        {
                          color: colors.foreground,
                          minWidth: editorInputMinWidth,
                        },
                      ]}
                    />
                  </ScrollView>
                </View>
              )}
              {editorRenderWhitespace ? (
                <View
                  style={[
                    styles.whitespacePreview,
                    {
                      backgroundColor: withAlpha(colors.foreground, 0.04),
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text style={[styles.whitespacePreviewText, { color: colors.tertiaryLabel }]}>
                    {formatWhitespacePreview(draft)}
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.codeInsightPanel,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                ]}
              >
                <View style={styles.codeInsightHeader}>
                  <View>
                    <Text style={[styles.codeInsightTitle, { color: colors.foreground }]}>
                      Code intelligence
                    </Text>
                    <Text style={[styles.codeInsightMeta, { color: colors.tertiaryLabel }]}>
                      Cursor line {cursorPosition.line + 1}
                    </Text>
                  </View>
                  {codeInsightLoading ? <ActivityIndicator color={colors.primary} /> : null}
                </View>
                <View style={styles.codeInsightActions}>
                  <Pressable
                    disabled={codeInsightLoading !== null || hostOffline}
                    onPress={() => void runCodeInsight("diagnostics")}
                    style={[
                      styles.codeInsightButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                      (codeInsightLoading !== null || hostOffline) && styles.disabled,
                    ]}
                  >
                    <ListChecks size={14} color={colors.primary} strokeWidth={2.1} />
                    <Text style={[styles.codeInsightButtonText, { color: colors.foreground }]}>
                      Analyze
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={codeInsightLoading !== null || !editorSuggestions || hostOffline}
                    onPress={() => void runCodeInsight("complete")}
                    style={[
                      styles.codeInsightButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                      (codeInsightLoading !== null || !editorSuggestions || hostOffline) &&
                        styles.disabled,
                    ]}
                  >
                    <Sparkles size={14} color={colors.primary} strokeWidth={2.1} />
                    <Text style={[styles.codeInsightButtonText, { color: colors.foreground }]}>
                      Complete
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={codeInsightLoading !== null || hostOffline}
                    onPress={() => void runCodeInsight("definition")}
                    style={[
                      styles.codeInsightButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                      (codeInsightLoading !== null || hostOffline) && styles.disabled,
                    ]}
                  >
                    <Crosshair size={14} color={colors.primary} strokeWidth={2.1} />
                    <Text style={[styles.codeInsightButtonText, { color: colors.foreground }]}>
                      Definition
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={codeInsightLoading !== null || hostOffline}
                    onPress={() => void runCodeInsight("references")}
                    style={[
                      styles.codeInsightButton,
                      {
                        backgroundColor: colors.surface,
                        borderColor: colors.elevatedBorder,
                      },
                      (codeInsightLoading !== null || hostOffline) && styles.disabled,
                    ]}
                  >
                    <Search size={14} color={colors.primary} strokeWidth={2.1} />
                    <Text style={[styles.codeInsightButtonText, { color: colors.foreground }]}>
                      References
                    </Text>
                  </Pressable>
                </View>
                {codeInsight ? (
                  <View style={styles.codeInsightResults}>
                    {codeInsight.message ? (
                      <Text style={[styles.codeInsightEmpty, { color: colors.secondaryLabel }]}>
                        {codeInsight.message}
                      </Text>
                    ) : null}
                    {codeInsight.diagnostics.slice(0, 6).map((diagnostic) => (
                      <View
                        key={`${diagnostic.source ?? "lsp"}-${diagnostic.startLine}-${diagnostic.startColumn}-${diagnostic.endLine}-${diagnostic.endColumn}-${diagnostic.message}`}
                      >
                        <Text style={[styles.codeInsightResultTitle, { color: colors.foreground }]}>
                          {diagnostic.severity.toUpperCase()} line {diagnostic.startLine + 1}
                        </Text>
                        <Text
                          style={[styles.codeInsightResultBody, { color: colors.secondaryLabel }]}
                        >
                          {diagnostic.message}
                        </Text>
                      </View>
                    ))}
                    {codeInsight.completions.slice(0, 8).map((item) => (
                      <View key={`${item.label}-${item.sortText ?? item.detail ?? ""}`}>
                        <Text style={[styles.codeInsightResultTitle, { color: colors.foreground }]}>
                          {item.label}
                        </Text>
                        {item.detail || item.documentation ? (
                          <Text
                            style={[styles.codeInsightResultBody, { color: colors.secondaryLabel }]}
                            numberOfLines={2}
                          >
                            {item.detail ?? item.documentation}
                          </Text>
                        ) : null}
                      </View>
                    ))}
                    {codeInsight.locations.slice(0, 8).map((location) => (
                      <View
                        key={`${location.relativePath}-${location.startLine}-${location.startColumn}-${location.endLine}-${location.endColumn}`}
                      >
                        <Text style={[styles.codeInsightResultTitle, { color: colors.foreground }]}>
                          {location.relativePath}
                        </Text>
                        <Text
                          style={[styles.codeInsightResultBody, { color: colors.secondaryLabel }]}
                        >
                          Line {location.startLine + 1}, column {location.startColumn + 1}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
              <View style={styles.fileActionGrid}>
                {saveConflict ? (
                  <View
                    style={[
                      styles.conflictPanel,
                      {
                        backgroundColor: withAlpha(colors.orange, 0.1),
                        borderColor: withAlpha(colors.orange, 0.26),
                      },
                    ]}
                  >
                    <Text style={[styles.conflictTitle, { color: colors.foreground }]}>
                      File changed on disk
                    </Text>
                    <Text style={[styles.conflictBody, { color: colors.secondaryLabel }]}>
                      {saveConflict.relativePath} changed on the host after this copy was loaded.
                      Keep the disk version or overwrite it with your mobile edits.
                    </Text>
                    <View style={styles.conflictStats}>
                      <Text style={[styles.conflictStat, { color: colors.secondaryLabel }]}>
                        Disk {saveConflict.currentContents.split("\n").length} lines
                      </Text>
                      <Text style={[styles.conflictStat, { color: colors.secondaryLabel }]}>
                        Mobile {draft.split("\n").length} lines
                      </Text>
                    </View>
                    <View style={styles.conflictActions}>
                      <Pressable
                        disabled={saving || hostOffline}
                        onPress={keepDiskVersion}
                        style={[
                          styles.conflictSecondaryButton,
                          {
                            backgroundColor: colors.surface,
                            borderColor: colors.elevatedBorder,
                          },
                          (saving || hostOffline) && styles.disabled,
                        ]}
                      >
                        <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>
                          Keep disk
                        </Text>
                      </Pressable>
                      <Pressable
                        disabled={saving || hostOffline}
                        onPress={() => void overwriteConflict()}
                        style={[
                          styles.conflictPrimaryButton,
                          { backgroundColor: colors.primary },
                          (saving || hostOffline) && styles.disabled,
                        ]}
                      >
                        <Text
                          style={[styles.secondaryButtonText, { color: colors.primaryForeground }]}
                        >
                          Overwrite
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null}
                <View
                  style={[
                    styles.renameShell,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Pencil size={15} color={colors.tertiaryLabel} strokeWidth={2.1} />
                  <TextInput
                    value={renamePath}
                    onChangeText={setRenamePath}
                    placeholder="Rename path"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.renameInput, { color: colors.foreground }]}
                  />
                </View>
                <View style={styles.fileActionRow}>
                  <Pressable
                    disabled={!canRename || mutatingEntry}
                    onPress={() => void renameSelectedFile()}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      (!canRename || mutatingEntry) && styles.disabled,
                    ]}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>
                      Rename
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={mutatingEntry || hostOffline}
                    onPress={deleteSelectedFile}
                    style={[
                      styles.dangerButton,
                      {
                        backgroundColor: withAlpha(colors.red, 0.12),
                        borderColor: withAlpha(colors.red, 0.18),
                      },
                      (mutatingEntry || hostOffline) && styles.disabled,
                    ]}
                  >
                    <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
                    <Text style={[styles.secondaryButtonText, { color: colors.red }]}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            </Panel>
          ) : null}

          {selectedPreviewEntry ? (
            <Panel style={styles.previewPanel}>
              <View style={styles.editorHeader}>
                <View style={styles.editorTitleCopy}>
                  <SectionTitle>
                    {selectedBinaryPreviewKind === "video" ? "Video preview" : "Image preview"}
                  </SectionTitle>
                  <Text style={[styles.editorPath, { color: colors.foreground }]} numberOfLines={1}>
                    {selectedPreviewEntry.path}
                  </Text>
                </View>
                <View
                  style={[styles.entryIcon, { backgroundColor: withAlpha(colors.primary, 0.12) }]}
                >
                  <FileText size={16} color={colors.primary} strokeWidth={2.1} />
                </View>
              </View>
              {selectedPreviewUrl ? (
                selectedBinaryPreviewKind === "image" ? (
                  <View
                    style={[
                      styles.binaryPreviewFrame,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Image
                      source={{ uri: selectedPreviewUrl }}
                      resizeMode="contain"
                      style={styles.binaryPreviewImage}
                      onError={() =>
                        setPreviewError("Unable to preview this image from the connected host.")
                      }
                    />
                  </View>
                ) : (
                  <View
                    style={[
                      styles.previewUnavailablePanel,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                    ]}
                  >
                    <Text style={[styles.previewUnavailableTitle, { color: colors.foreground }]}>
                      Video preview opens in the browser
                    </Text>
                    <Text style={[styles.previewUnavailableBody, { color: colors.secondaryLabel }]}>
                      Mobile uses the in-app browser for workspace video playback.
                    </Text>
                  </View>
                )
              ) : (
                <View
                  style={[
                    styles.previewUnavailablePanel,
                    {
                      backgroundColor: colors.surfaceSecondary,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text style={[styles.previewUnavailableTitle, { color: colors.foreground }]}>
                    Preview unavailable for this connection
                  </Text>
                  <Text style={[styles.previewUnavailableBody, { color: colors.secondaryLabel }]}>
                    Direct hosts can serve workspace previews over HTTP. Relay hosts need a host
                    file preview bridge before binary previews can load on mobile.
                  </Text>
                </View>
              )}
              {previewError ? (
                <Text style={[styles.previewErrorText, { color: colors.red }]}>{previewError}</Text>
              ) : null}
              {selectedPreviewUrl ? (
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/thread/browser",
                      params: { url: selectedPreviewUrl },
                    })
                  }
                  style={[
                    styles.openPreviewButton,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Text style={[styles.openPreviewButtonText, { color: colors.primary }]}>
                    Open in browser
                  </Text>
                </Pressable>
              ) : null}
            </Panel>
          ) : null}

          {selectedDirectory ? (
            <Panel style={styles.directoryPanel}>
              <View style={styles.editorHeader}>
                <View style={styles.editorTitleCopy}>
                  <SectionTitle>Folder</SectionTitle>
                  <Text style={[styles.editorPath, { color: colors.foreground }]} numberOfLines={1}>
                    {selectedDirectory.path}
                  </Text>
                </View>
                <View
                  style={[styles.entryIcon, { backgroundColor: withAlpha(colors.primary, 0.12) }]}
                >
                  <Folder size={16} color={colors.primary} strokeWidth={2.1} />
                </View>
              </View>
              <View style={styles.fileActionGrid}>
                <View
                  style={[
                    styles.renameShell,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                  ]}
                >
                  <Pencil size={15} color={colors.tertiaryLabel} strokeWidth={2.1} />
                  <TextInput
                    value={directoryRenamePath}
                    onChangeText={setDirectoryRenamePath}
                    placeholder="Rename folder path"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={[styles.renameInput, { color: colors.foreground }]}
                  />
                </View>
                <View style={styles.fileActionRow}>
                  <Pressable
                    disabled={!canRenameDirectory || mutatingEntry}
                    onPress={() => void renameSelectedDirectory()}
                    style={[
                      styles.secondaryButton,
                      {
                        backgroundColor: colors.surfaceSecondary,
                        borderColor: colors.elevatedBorder,
                      },
                      (!canRenameDirectory || mutatingEntry) && styles.disabled,
                    ]}
                  >
                    <Text style={[styles.secondaryButtonText, { color: colors.foreground }]}>
                      Rename
                    </Text>
                  </Pressable>
                  <Pressable
                    disabled={mutatingEntry || hostOffline}
                    onPress={deleteSelectedDirectory}
                    style={[
                      styles.dangerButton,
                      {
                        backgroundColor: withAlpha(colors.red, 0.12),
                        borderColor: withAlpha(colors.red, 0.18),
                      },
                      (mutatingEntry || hostOffline) && styles.disabled,
                    ]}
                  >
                    <Trash2 size={15} color={colors.red} strokeWidth={2.1} />
                    <Text style={[styles.secondaryButtonText, { color: colors.red }]}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            </Panel>
          ) : null}

          {fileError ? (
            <View
              style={[
                styles.fileErrorPanel,
                {
                  backgroundColor: withAlpha(colors.red, 0.1),
                  borderColor: withAlpha(colors.red, 0.18),
                },
              ]}
            >
              <View style={styles.fileErrorCopy}>
                <Text style={[styles.fileErrorTitle, { color: colors.foreground }]}>
                  Could not open file
                </Text>
                <Text style={[styles.fileErrorBody, { color: colors.secondaryLabel }]}>
                  {fileError}
                </Text>
              </View>
              {failedFileEntry ? (
                <Pressable
                  disabled={loadingFile || hostOffline}
                  onPress={() => void openFile(failedFileEntry)}
                  style={[
                    styles.fileErrorRetryButton,
                    {
                      backgroundColor: colors.surface,
                      borderColor: colors.elevatedBorder,
                    },
                    (loadingFile || hostOffline) && styles.disabled,
                  ]}
                >
                  {loadingFile ? (
                    <ActivityIndicator color={colors.primary} />
                  ) : (
                    <RefreshCw size={15} color={colors.primary} strokeWidth={2.2} />
                  )}
                  <Text style={[styles.fileErrorRetryText, { color: colors.primary }]}>Retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <View style={styles.sectionHeader}>
            <SectionTitle>Workspace</SectionTitle>
            <Text style={[styles.sectionMeta, { color: colors.tertiaryLabel }]}>
              {query.trim().length > 0
                ? `${visibleEntries.length} matches`
                : `${visibleEntries.length} visible`}
            </Text>
          </View>

          <Panel style={styles.createPanel}>
            <TextInput
              value={newEntryPath}
              onChangeText={setNewEntryPath}
              placeholder="new/file-or-folder"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                styles.createInput,
                {
                  color: colors.foreground,
                  backgroundColor: colors.surfaceSecondary,
                  borderColor: colors.elevatedBorder,
                },
              ]}
            />
            <View style={styles.createActions}>
              <Pressable
                disabled={mutatingEntry || hostOffline}
                onPress={() => void createEntry("file")}
                style={[
                  styles.createButton,
                  { backgroundColor: colors.primary },
                  (mutatingEntry || hostOffline) && styles.disabled,
                ]}
              >
                <FilePlus2 size={15} color={colors.primaryForeground} strokeWidth={2.2} />
                <Text style={[styles.createButtonText, { color: colors.primaryForeground }]}>
                  File
                </Text>
              </Pressable>
              <Pressable
                disabled={mutatingEntry || hostOffline}
                onPress={() => void createEntry("directory")}
                style={[
                  styles.createButtonSecondary,
                  {
                    backgroundColor: colors.surfaceSecondary,
                    borderColor: colors.elevatedBorder,
                  },
                  (mutatingEntry || hostOffline) && styles.disabled,
                ]}
              >
                <FolderPlus size={15} color={colors.primary} strokeWidth={2.2} />
                <Text style={[styles.createButtonText, { color: colors.foreground }]}>Folder</Text>
              </Pressable>
            </View>
          </Panel>

          {loadingTree && entries.length === 0 ? (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : visibleEntries.length === 0 ? (
            <EmptyState
              title="No files found"
              body="Pull to refresh the workspace or adjust the path search."
            />
          ) : (
            <Panel padded={false} style={styles.listShell}>
              {visibleEntries.map((entry, index) => {
                const isSelected =
                  selectedFile?.relativePath === entry.path ||
                  selectedPreviewEntry?.path === entry.path ||
                  selectedDirectory?.path === entry.path;
                const depth = Math.max(0, entry.path.split("/").length - 1);
                const Icon = entry.kind === "directory" ? Folder : FileText;
                return (
                  <Pressable
                    key={`${entry.kind}-${entry.path}`}
                    disabled={loadingFile || hostOffline}
                    onPress={() => openEntry(entry)}
                    style={({ pressed }) => [
                      styles.entryRow,
                      {
                        paddingLeft: 16 + Math.min(depth, 4) * 12,
                        backgroundColor: isSelected
                          ? withAlpha(colors.primary, 0.1)
                          : pressed
                            ? withAlpha(colors.foreground, 0.04)
                            : "transparent",
                      },
                    ]}
                  >
                    <View
                      style={[
                        styles.entryIcon,
                        {
                          backgroundColor: withAlpha(
                            entry.kind === "directory" ? colors.primary : colors.foreground,
                            entry.kind === "directory" ? 0.12 : 0.07,
                          ),
                        },
                      ]}
                    >
                      <Icon
                        size={16}
                        color={entry.kind === "directory" ? colors.primary : colors.secondaryLabel}
                        strokeWidth={2.1}
                      />
                    </View>
                    <View style={styles.entryCopy}>
                      <Text
                        style={[styles.entryTitle, { color: colors.foreground }]}
                        numberOfLines={1}
                      >
                        {basename(entry.path)}
                      </Text>
                      <Text
                        style={[styles.entryPath, { color: colors.tertiaryLabel }]}
                        numberOfLines={1}
                      >
                        {entry.path}
                      </Text>
                    </View>
                    {index < visibleEntries.length - 1 ? (
                      <View style={[styles.separator, { backgroundColor: colors.separator }]} />
                    ) : null}
                  </Pressable>
                );
              })}
            </Panel>
          )}

          {treeError ? (
            <Text style={[styles.errorText, { color: colors.red }]}>{treeError}</Text>
          ) : null}
          {searchError ? (
            <Text style={[styles.errorText, { color: colors.red }]}>{searchError}</Text>
          ) : null}
          {searchTruncated ? (
            <Text style={[styles.helperText, { color: colors.secondaryLabel }]}>
              Search results were truncated by the host. Narrow the query to find more specific
              paths.
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    paddingHorizontal: Layout.pagePadding,
    paddingBottom: 14,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  headerButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.14,
    shadowRadius: 28,
    elevation: 0,
  },
  headerCopy: {
    flex: 1,
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.24,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 5,
    fontSize: 22,
    lineHeight: 26,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  subtitle: {
    marginTop: 5,
    fontSize: 13,
    lineHeight: 18,
  },
  saveButton: {
    width: 44,
    height: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: {
    opacity: 0.62,
  },
  searchShell: {
    minHeight: 52,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 15,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  connectionRecoveryBanner: {
    marginTop: 12,
    minHeight: 72,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  connectionRecoveryCopy: {
    flex: 1,
    minWidth: 0,
  },
  connectionRecoveryTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  connectionRecoveryBody: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  connectionReconnectButton: {
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  connectionReconnectLabel: {
    fontSize: 13,
    fontWeight: "800",
  },
  editorPanel: {
    marginTop: 16,
  },
  previewPanel: {
    marginTop: 16,
  },
  directoryPanel: {
    marginTop: 16,
  },
  editorHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  editorTitleCopy: {
    flex: 1,
  },
  editorPath: {
    marginTop: 7,
    fontSize: 16,
    lineHeight: 20,
    fontWeight: "800",
    letterSpacing: -0.35,
  },
  dirtyLabel: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.18,
  },
  editorInputFrame: {
    marginTop: 14,
    minHeight: 320,
    borderWidth: 1,
    borderRadius: Radius.input,
    flexDirection: "row",
    overflow: "hidden",
  },
  lineNumberGutter: {
    width: 48,
    paddingTop: 13,
    paddingBottom: 13,
    paddingRight: 8,
    borderRightWidth: StyleSheet.hairlineWidth,
    alignItems: "flex-end",
  },
  lineNumberText: {
    height: 19,
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 19,
    fontWeight: "700",
  },
  editorScroll: {
    flex: 1,
  },
  editorInput: {
    minHeight: 318,
    paddingHorizontal: 13,
    paddingTop: 13,
    paddingBottom: 13,
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    textAlignVertical: "top",
  },
  previewModeToggle: {
    marginTop: 14,
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.pill,
    padding: 4,
    flexDirection: "row",
    gap: 4,
  },
  previewModeButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: "transparent",
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  previewModeButtonText: {
    fontSize: 13,
    fontWeight: "800",
  },
  markdownPreviewFrame: {
    marginTop: 12,
    minHeight: 320,
    maxHeight: 560,
    borderWidth: 1,
    borderRadius: Radius.input,
  },
  markdownPreviewContent: {
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  binaryPreviewFrame: {
    marginTop: 14,
    height: 360,
    borderWidth: 1,
    borderRadius: Radius.input,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  binaryPreviewImage: {
    width: "100%",
    height: "100%",
  },
  previewUnavailablePanel: {
    marginTop: 14,
    minHeight: 180,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 16,
    paddingVertical: 16,
    justifyContent: "center",
  },
  previewUnavailableTitle: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "800",
  },
  previewUnavailableBody: {
    marginTop: 6,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  previewErrorText: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  openPreviewButton: {
    marginTop: 12,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  openPreviewButtonText: {
    fontSize: 13,
    fontWeight: "800",
  },
  whitespacePreview: {
    marginTop: 8,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  whitespacePreviewText: {
    fontFamily: MONO,
    fontSize: 11,
    lineHeight: 16,
  },
  codeInsightPanel: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: Radius.input,
    padding: 12,
    gap: 10,
  },
  codeInsightHeader: {
    minHeight: 34,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  codeInsightTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  codeInsightMeta: {
    marginTop: 3,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  codeInsightActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  codeInsightButton: {
    minHeight: 44,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  codeInsightButtonText: {
    fontSize: 12,
    lineHeight: 16,
    fontWeight: "800",
  },
  codeInsightResults: {
    gap: 10,
  },
  codeInsightEmpty: {
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  codeInsightResultTitle: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: "800",
  },
  codeInsightResultBody: {
    marginTop: 3,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  fileActionGrid: {
    marginTop: 14,
    gap: 10,
  },
  renameShell: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 13,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  renameInput: {
    flex: 1,
    fontSize: 14,
    fontWeight: "600",
  },
  fileActionRow: {
    flexDirection: "row",
    gap: 9,
  },
  secondaryButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  conflictPanel: {
    borderWidth: 1,
    borderRadius: Radius.input,
    padding: 12,
  },
  conflictTitle: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "800",
  },
  conflictBody: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  conflictStats: {
    marginTop: 10,
    flexDirection: "row",
    gap: 8,
  },
  conflictStat: {
    flex: 1,
    fontSize: 11,
    lineHeight: 15,
    fontWeight: "800",
  },
  conflictActions: {
    marginTop: 12,
    flexDirection: "row",
    gap: 8,
  },
  conflictSecondaryButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: Radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  conflictPrimaryButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: Radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  sectionHeader: {
    marginTop: 22,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionMeta: {
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.18,
  },
  createPanel: {
    marginBottom: 12,
  },
  createInput: {
    minHeight: 48,
    borderWidth: 1,
    borderRadius: Radius.input,
    paddingHorizontal: 14,
    fontSize: 14,
    fontWeight: "600",
  },
  createActions: {
    marginTop: 10,
    flexDirection: "row",
    gap: 9,
  },
  createButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  createButtonSecondary: {
    flex: 1,
    minHeight: 44,
    borderRadius: Radius.pill,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  createButtonText: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.1,
  },
  listShell: {
    overflow: "hidden",
  },
  entryRow: {
    minHeight: 68,
    paddingRight: 16,
    paddingVertical: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  entryIcon: {
    width: 36,
    height: 36,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  entryCopy: {
    flex: 1,
  },
  entryTitle: {
    fontSize: 15,
    lineHeight: 19,
    fontWeight: "800",
    letterSpacing: -0.24,
  },
  entryPath: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
  },
  separator: {
    position: "absolute",
    left: 16,
    right: 16,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  loadingWrap: {
    paddingVertical: 44,
    alignItems: "center",
  },
  fileErrorPanel: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: Radius.input,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  fileErrorCopy: {
    flex: 1,
    minWidth: 0,
  },
  fileErrorTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "800",
  },
  fileErrorBody: {
    marginTop: 4,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  fileErrorRetryButton: {
    minHeight: 42,
    borderRadius: Radius.pill,
    borderWidth: 1,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  fileErrorRetryText: {
    fontSize: 13,
    fontWeight: "800",
  },
  errorText: {
    marginTop: 12,
    fontSize: 13,
    lineHeight: 18,
  },
  helperText: {
    marginTop: 10,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
});

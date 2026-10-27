import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { FlashList } from "@shopify/flash-list";
import { AceHost, tokens, useTheme, textStyle } from "./theme.tsx";
import { AceButton, AceText, Row } from "./components.tsx";
import {
  followFileChanges,
  formatFileSize,
  listTree,
  quickOpen,
  readFileContent,
  visibleTreeRows,
  type FileContentView,
  type FileSearchRowView,
  type FileTreeRowView,
  type FilesClient,
  type FilesScope,
} from "./files.ts";

/*
 * Android file viewing: the thread checkout's tree with quick open, then one file.
 * Read-only: rows never offer a mutation, and the viewer never sends one. Screens take
 * the client as a prop so they stay navigation-agnostic; no App routing changes here.
 */

function TreeRow({ row, open, onTap }: { row: FileTreeRowView; open: boolean; onTap(): void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityLabel={`file.${row.path}`}
      onPress={onTap}
      style={{
        paddingLeft: tokens.spacing.xl + row.depth * 18,
        paddingRight: tokens.spacing.xl,
        minHeight: 42,
        justifyContent: "center",
        borderBottomWidth: tokens.dimensions.border,
        borderBottomColor: theme.colours.separator,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: tokens.spacing.sm }}>
        <Text style={{ ...textStyle("caption"), color: theme.colours.decoration, width: 10 }}>
          {row.folder ? (open ? "▾" : "▸") : ""}
        </Text>
        <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground, width: 22 }}>
          {row.folder ? "📁" : "📄"}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            ...textStyle("body"),
            color: row.mark === "D" ? theme.colours.mutedForeground : theme.colours.foreground,
            flex: 1,
            textDecorationLine: row.mark === "D" ? "line-through" : "none",
          }}
        >
          {row.name}
        </Text>
        {row.mark ? (
          <Text
            accessibilityLabel={row.markLabel ?? row.mark}
            style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}
          >
            {row.mark}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export function FilesScreen({
  client,
  scope,
  onOpenFile,
  notify,
}: {
  client: FilesClient;
  scope: FilesScope;
  onOpenFile(path: string, line?: number): void;
  notify(text: string): void;
}) {
  const theme = useTheme();
  // Pass a stable `scope` object: a fresh literal per render would reload the tree.
  const [rows, setRows] = useState<FileTreeRowView[] | undefined>();
  const [allPaths, setAllPaths] = useState<string[]>([]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const openSeeded = useRef(false);
  const loaded = useRef(false);
  const [truncated, setTruncated] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void listTree(client, scope, controller.signal)
      .then((tree) => {
        if (!active) return;
        loaded.current = true;
        setRows(tree.rows);
        setAllPaths(tree.rows.filter((entry) => !entry.folder).map((entry) => entry.path));
        setTruncated(tree.truncated);
        setFailure(undefined);
        if (!openSeeded.current) {
          openSeeded.current = true;
          setOpen(new Set(tree.open));
        }
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Couldn't read the files.";
        if (loaded.current) notify(message);
        else setFailure(message);
      });
    return () => {
      active = false;
      controller.abort();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `revision` names the reload generation.
  }, [client, scope, revision, notify]);

  useEffect(() => followFileChanges(client, () => setRevision((n) => n + 1)), [client]);

  const visible = useMemo(() => (rows ? visibleTreeRows(rows, open) : []), [rows, open]);
  const trimmed = query.trim();
  const search: FileSearchRowView[] = useMemo(
    () => (trimmed ? quickOpen(trimmed, allPaths) : []),
    [trimmed, allPaths],
  );

  function tap(row: FileTreeRowView) {
    if (row.folder) {
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(row.path)) next.delete(row.path);
        else next.add(row.path);
        return next;
      });
    } else {
      onOpenFile(row.path);
    }
  }

  return (
    <AceHost style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: theme.colours.background }}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search files"
          placeholderTextColor={theme.colours.mutedForeground}
          autoCorrect={false}
          autoCapitalize="none"
          style={{
            ...textStyle("body"),
            color: theme.colours.foreground,
            borderBottomWidth: tokens.dimensions.border,
            borderBottomColor: theme.colours.separator,
            padding: tokens.spacing.md,
          }}
        />
        {failure ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText>Couldn't read the files ({failure})</AceText>
            <Row>
              <AceButton
                label="Try again"
                onPress={() => setRevision((n) => n + 1)}
                kind="secondary"
              />
            </Row>
          </View>
        ) : rows === undefined ? (
          <ActivityIndicator style={{ marginTop: tokens.spacing.xl }} />
        ) : trimmed ? (
          <FlashList
            data={search}
            keyExtractor={(item) => item.path}
            renderItem={({ item }) => (
              <Pressable
                accessibilityLabel={`search.${item.path}`}
                onPress={() => {
                  if (item.isFolder) {
                    setOpen((prev) => {
                      const next = new Set(prev);
                      let path = "";
                      for (const part of item.path.split("/").filter(Boolean)) {
                        path += `${part}/`;
                        next.add(path);
                      }
                      return next;
                    });
                    setQuery("");
                  } else {
                    onOpenFile(item.path);
                  }
                }}
                style={{ padding: tokens.spacing.md, paddingLeft: tokens.spacing.xl }}
              >
                <AceText role="rowTitle">{item.name}</AceText>
                {item.folder ? (
                  <AceText role="caption" colour={theme.colours.mutedForeground}>
                    {item.folder}
                  </AceText>
                ) : null}
              </Pressable>
            )}
            ListEmptyComponent={
              <View style={{ padding: tokens.spacing.xl }}>
                <AceText colour={theme.colours.mutedForeground}>
                  No files match "{trimmed}".
                </AceText>
              </View>
            }
          />
        ) : (
          <FlashList
            data={visible}
            keyExtractor={(item) => item.path}
            renderItem={({ item }) => (
              <TreeRow row={item} open={open.has(item.path)} onTap={() => tap(item)} />
            )}
            ListEmptyComponent={
              <View style={{ padding: tokens.spacing.xl }}>
                <AceText colour={theme.colours.mutedForeground}>No files.</AceText>
              </View>
            }
            ListFooterComponent={
              truncated ? (
                <View style={{ padding: tokens.spacing.lg }}>
                  <AceText role="caption" colour={theme.colours.mutedForeground}>
                    Showing the first 1,000 entries. Search by name to find more.
                  </AceText>
                </View>
              ) : null
            }
          />
        )}
      </View>
    </AceHost>
  );
}

function TextBody({
  content,
  atLine,
}: {
  content: Extract<FileContentView, { kind: "text" }>;
  atLine?: number;
}) {
  const theme = useTheme();
  const lines = useMemo(() => content.text.split("\n"), [content.text]);
  const marks = useMemo(() => {
    const byLine = new Map<number, string>();
    for (const mark of content.marks) byLine.set(mark.line, mark.kind);
    return byLine;
  }, [content.marks]);
  return (
    <FlashList
      data={lines}
      keyExtractor={(_, index) => `${content.path}:${index}`}
      initialScrollIndex={atLine && atLine > 1 && atLine <= lines.length ? atLine - 1 : undefined}
      renderItem={({ index }) => {
        const mark = marks.get(index + 1);
        return (
          <View style={{ flexDirection: "row", minHeight: 22 }}>
            <View
              style={{
                width: 44,
                backgroundColor:
                  mark === "added"
                    ? theme.status.done
                    : mark === "removed"
                      ? theme.status.failed
                      : theme.colours.secondaryBackground,
                opacity: mark ? 0.35 : 1,
              }}
            >
              <Text
                style={{
                  ...textStyle("code"),
                  color: theme.colours.mutedForeground,
                  textAlign: "right",
                  paddingRight: tokens.spacing.sm,
                }}
              >
                {index + 1}
              </Text>
            </View>
            {/* One visual row per source line: horizontal scroll keeps each row a
                fixed 22 px tall, so `atLine` lands on the right line. */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
              <Text
                numberOfLines={1}
                style={{
                  ...textStyle("code"),
                  color: theme.colours.foreground,
                  paddingLeft: tokens.spacing.sm,
                  paddingRight: tokens.spacing.md,
                }}
              >
                {lines[index] === "" ? " " : lines[index]}
              </Text>
            </ScrollView>
          </View>
        );
      }}
    />
  );
}

export function FileScreen({
  client,
  scope,
  path,
  line,
  notify,
}: {
  client: FilesClient;
  scope: FilesScope;
  path: string;
  line?: number;
  notify(text: string): void;
}) {
  const theme = useTheme();
  const [loaded, setLoaded] = useState<{ path: string; content: FileContentView } | undefined>();
  const [loadFailure, setLoadFailure] = useState<{ path: string; message: string } | undefined>();
  const [preview, setPreview] = useState(true);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void readFileContent(client, scope, path, controller.signal)
      .then((next) => {
        if (active) setLoaded({ path, content: next });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Couldn't open the file.";
        setLoadFailure({ path, message });
        notify(message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, scope, path, notify]);
  // A new path keeps the previous file's content off screen until its own read lands.
  const content = loaded?.path === path ? loaded.content : undefined;
  const failure = loadFailure?.path === path ? loadFailure.message : undefined;

  return (
    <AceHost style={{ flex: 1 }}>
      <View style={{ flex: 1, backgroundColor: theme.colours.background }}>
        {content?.kind === "text" && content.markdown ? (
          <Row>
            <AceButton
              label={preview ? "View source" : "View preview"}
              onPress={() => setPreview((p) => !p)}
              kind="secondary"
            />
            {content.language ? (
              <AceText role="caption" colour={theme.colours.mutedForeground}>
                {content.language} · {formatFileSize(content.size)}
              </AceText>
            ) : null}
          </Row>
        ) : null}
        {content === undefined ? (
          failure ? (
            <View style={{ padding: tokens.spacing.xl }}>
              <AceText>
                Couldn't open {path} ({failure})
              </AceText>
            </View>
          ) : (
            <ActivityIndicator style={{ marginTop: tokens.spacing.xl }} />
          )
        ) : content.kind === "missing" ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText role="rowTitle">Not in the checkout</AceText>
            <AceText colour={theme.colours.mutedForeground}>
              Nothing is at {path} in this thread's checkout. It may have been moved or deleted.
            </AceText>
          </View>
        ) : content.kind === "folder" ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText>That's a folder; pick a file inside it.</AceText>
          </View>
        ) : content.kind === "large" ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText role="rowTitle">Too large to show here</AceText>
            <AceText colour={theme.colours.mutedForeground}>
              {path} is {formatFileSize(content.size)}. Files over 2 MB open as a download — get it
              on your computer.
            </AceText>
          </View>
        ) : content.kind === "binary" ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText role="rowTitle">Binary file</AceText>
            <AceText colour={theme.colours.mutedForeground}>
              {path} ({formatFileSize(content.size)}) isn't text, so there's nothing to read here.
            </AceText>
          </View>
        ) : content.kind === "image" ? (
          <View style={{ flex: 1, padding: tokens.spacing.xl, gap: tokens.spacing.md }}>
            <Image
              source={{ uri: content.dataUri }}
              resizeMode="contain"
              accessibilityLabel={path}
              style={{ flex: 1, width: "100%" }}
            />
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              {formatFileSize(content.size)}
            </AceText>
          </View>
        ) : content.text === "" ? (
          <View style={{ padding: tokens.spacing.xl }}>
            <AceText colour={theme.colours.mutedForeground}>{path} has no content.</AceText>
          </View>
        ) : content.markdown && preview ? (
          <View style={{ flex: 1, padding: tokens.spacing.xl }}>
            <AceText role="caption" colour={theme.colours.mutedForeground}>
              Markdown preview
            </AceText>
            <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
              {content.text}
            </Text>
          </View>
        ) : (
          <TextBody content={content} {...(line === undefined ? {} : { atLine: line })} />
        )}
      </View>
    </AceHost>
  );
}

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { tokens, textStyle, useTheme } from "../theme.tsx";
import {
  accumulateStreamingBlocks,
  blockFingerprint,
  codeLineCount,
  fingerprintText,
  isCodeCollapsible,
  isOverInlineLimit,
  isSafeWebUrl,
  longMessagePreview,
  markdownBlocks,
  markdownInline,
  markdownPieces,
  spanFingerprint,
  visibleCodeText,
  withStableKeys,
  type MarkdownBlock,
  type StreamingAccumulator,
} from "./markdown.ts";
import { openWebLink } from "./links.ts";
import { copyCodeText } from "./clipboard.ts";

/**
 * Agent Markdown as native text (A05.02, iOS `MarkdownView` behavior).
 *
 * Inline syntax is a documented subset (see `markdown.ts`): bold, italic,
 * code and safe `http(s)` links. `ace://` stays literal; the Files screen
 * remains the only file route. Messages past `INLINE_MESSAGE_LIMIT` render a
 * bounded plain preview plus a Copy-full-answer action instead of parsing
 * unbounded text per delta. Large streaming messages parse the settled head
 * once and re-parse only a bounded tail per delta. Blocks are keyed by
 * full-content fingerprint with occurrence counting: append-only deltas keep
 * settled blocks, while a mid-stream structural change (fence closes,
 * `---` becomes a rule) remounts only what changed.
 */
const NO_BLOCKS: MarkdownBlock[] = [];

/**
 * Incremental blocks for a streaming message: settled head blocks are parsed
 * once and referentially stable across deltas, the tail re-parses bounded.
 * Falls back to the full parse for short text, un-splittable text, and once
 * the stream settles. All hooks run every render; callers keep early returns
 * below this hook.
 */
function useStreamingBlocks(
  text: string,
  streaming: boolean | undefined,
  overLimit: boolean,
): MarkdownBlock[] {
  const settled = useRef<StreamingAccumulator>({ head: "", blocks: [] });
  return useMemo(
    // Render-phase memo cache: nextBlocks is a deterministic function of
    // text, so a repeated render recomputes identically; the cache only
    // skips re-parsing the settled head on every streaming delta.
    // eslint-disable-next-line react/refs
    () => nextBlocks(settled, text, streaming, overLimit),
    [text, streaming, overLimit],
  );
}

function nextBlocks(
  settled: { current: StreamingAccumulator },
  text: string,
  streaming: boolean | undefined,
  overLimit: boolean,
): MarkdownBlock[] {
  if (!streaming || overLimit) {
    settled.current = { head: "", blocks: [] };
    return overLimit ? NO_BLOCKS : markdownBlocks(text);
  }
  const result = accumulateStreamingBlocks(settled.current, text);
  settled.current = result.state;
  return result.blocks;
}
export const Markdown = memo(function Markdown({
  text,
  streaming,
  notify,
}: {
  text: string;
  streaming?: boolean;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const overLimit = isOverInlineLimit(text);
  const preview = useMemo(() => (overLimit ? longMessagePreview(text) : ""), [text, overLimit]);
  const blocks = useStreamingBlocks(text, streaming, overLimit);
  // Content keys: append-only deltas keep settled blocks; a structural
  // change mid-stream remounts only what changed.
  const keyedBlocks = useMemo(() => withStableKeys(blocks, blockFingerprint), [blocks]);
  const [copyAll, setCopyAll] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyAll === "idle") return undefined;
    const timer = setTimeout(() => setCopyAll("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyAll]);
  if (text === "") return null;
  if (overLimit) {
    return (
      <View style={{ gap: tokens.spacing.sm }} testID="markdown">
        <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
          This answer is too long to show here.
        </Text>
        <Text
          style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}
          testID="markdown.tooLong"
          selectable
        >
          {preview}
        </Text>
        <Pressable
          onPress={() => {
            if (copyCodeText(text)) setCopyAll("copied");
            else {
              setCopyAll("failed");
              notify?.("The full answer could not be copied");
            }
          }}
          accessibilityLabel="Copy full answer"
          testID="markdown.copyAll"
          style={{
            paddingHorizontal: tokens.spacing.md,
            minHeight: tokens.spacing.xxxl,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
            {copyAll === "copied"
              ? "Copied"
              : copyAll === "failed"
                ? "Copy failed — try again"
                : "Copy full answer"}
          </Text>
        </Pressable>
        {streaming ? (
          <Text
            style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}
            accessibilityLabel="Streaming"
          >
            {"▍"}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={{ gap: tokens.spacing.sm }} testID="markdown">
      {keyedBlocks.map(({ key, value }) => (
        <BlockRow key={key} block={value} notify={notify} />
      ))}
      {streaming ? (
        <Text
          style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}
          accessibilityLabel="Streaming"
        >
          {"▍"}
        </Text>
      ) : null}
    </View>
  );
});

const BlockRow = memo(function BlockRow({
  block,
  notify,
}: {
  block: MarkdownBlock;
  notify?: ((text: string) => void) | undefined;
}) {
  switch (block.kind) {
    case "paragraph":
      return <Paragraph text={block.text} notify={notify} />;
    case "heading":
      return <Heading level={block.level} text={block.text} notify={notify} />;
    case "code":
      return <CodeBlock language={block.language} text={block.text} notify={notify} />;
    case "list":
      return (
        <MarkdownList
          ordered={block.ordered}
          start={block.start}
          items={block.items}
          notify={notify}
        />
      );
    case "quote":
      return <Quote text={block.text} notify={notify} />;
    case "table":
      return <MarkdownTable headers={block.headers} rows={block.rows} notify={notify} />;
    case "rule":
      return <Rule />;
  }
});

/** One run of prose, flowing inside a single Text so sentence pieces wrap. */
const Paragraph = memo(function Paragraph({
  text,
  notify,
}: {
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const pieces = useMemo(() => markdownPieces(text), [text]);
  const keyedPieces = useMemo(() => withStableKeys(pieces, fingerprintText), [pieces]);
  return (
    <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
      {keyedPieces.map(({ key, value }) => (
        <Piece key={key} text={value} notify={notify} />
      ))}
    </Text>
  );
});

const Piece = memo(function Piece({
  text,
  notify,
}: {
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const spans = useMemo(() => markdownInline(text), [text]);
  return (
    <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
      <Inline spans={spans} notify={notify} />
    </Text>
  );
});

function MemoInline({
  text,
  notify,
}: {
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const spans = useMemo(() => markdownInline(text), [text]);
  return <Inline spans={spans} notify={notify} />;
}

const Heading = memo(function Heading({
  level,
  text,
  notify,
}: {
  level: number;
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <Text
      style={{
        ...textStyle(level <= 2 ? "title" : "rowTitle"),
        color: theme.colours.foreground,
      }}
      accessibilityRole="header"
    >
      <MemoInline text={text} notify={notify} />
    </Text>
  );
});

function Inline({
  spans,
  notify,
}: {
  spans: ReturnType<typeof markdownInline>;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const keyed = useMemo(() => withStableKeys(spans, spanFingerprint), [spans]);
  return (
    <>
      {keyed.map(({ key, value: span }) => {
        switch (span.kind) {
          case "strong":
            return (
              <Text key={key} style={{ fontWeight: "700" }}>
                {span.text}
              </Text>
            );
          case "emphasis":
            return (
              <Text key={key} style={{ fontStyle: "italic" }}>
                {span.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={key}
                style={{
                  ...textStyle("code"),
                  backgroundColor: theme.colours.fill,
                }}
              >
                {span.text}
              </Text>
            );
          case "link":
            if (!isSafeWebUrl(span.url)) {
              return <Text key={key}>{span.text}</Text>;
            }
            return (
              <Text
                key={key}
                style={{ color: theme.colours.accent, textDecorationLine: "underline" }}
                accessibilityRole="link"
                onPress={() => {
                  void openWebLink(span.url).then((opened) => {
                    if (!opened) notify?.("That link could not be opened");
                  });
                }}
              >
                {span.text}
              </Text>
            );
          default:
            return <Text key={key}>{span.text}</Text>;
        }
      })}
    </>
  );
}

const CodeBlock = memo(function CodeBlock({
  language,
  text,
  notify,
}: {
  language: string;
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [expanded, setExpanded] = useState(false);
  const collapsible = useMemo(() => isCodeCollapsible(text), [text]);
  const shown = useMemo(() => visibleCodeText(text, expanded), [text, expanded]);
  const lineCount = useMemo(() => codeLineCount(text), [text]);
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);
  return (
    <View
      testID="markdown.code"
      style={{
        backgroundColor: theme.colours.fill,
        borderRadius: tokens.radii.bubble,
        borderWidth: tokens.dimensions.border,
        borderColor: theme.colours.separator,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          paddingLeft: tokens.spacing.md,
          paddingRight: tokens.spacing.xs,
          minHeight: 32,
        }}
      >
        <Text
          style={{ ...textStyle("caption"), color: theme.colours.subtleForeground, flex: 1 }}
          numberOfLines={1}
        >
          {language === "" ? "text" : language}
        </Text>
        <Pressable
          onPress={() => {
            if (copyCodeText(text)) setCopyState("copied");
            else {
              setCopyState("failed");
              notify?.("Code could not be copied");
            }
          }}
          accessibilityLabel={
            copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy code"
          }
          style={{
            paddingHorizontal: tokens.spacing.sm,
            minHeight: tokens.spacing.xxxl,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...textStyle("caption"), color: theme.colours.subtleForeground }}>
            {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
          </Text>
        </Pressable>
      </View>
      <View
        style={{ height: tokens.dimensions.border, backgroundColor: theme.colours.separator }}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text
          style={{
            ...textStyle("code"),
            color: theme.colours.foreground,
            paddingHorizontal: tokens.spacing.md,
            paddingTop: tokens.spacing.sm,
            paddingBottom: tokens.spacing.md,
          }}
          selectable
        >
          {shown}
        </Text>
      </ScrollView>
      {collapsible ? (
        <>
          <View
            style={{ height: tokens.dimensions.border, backgroundColor: theme.colours.separator }}
          />
          <Pressable
            onPress={() => setExpanded((open) => !open)}
            accessibilityValue={{ text: expanded ? "Expanded" : "Collapsed" }}
            style={{
              paddingHorizontal: tokens.spacing.md,
              minHeight: tokens.spacing.xxxl,
              justifyContent: "center",
            }}
          >
            <Text style={{ ...textStyle("caption"), color: theme.colours.mutedForeground }}>
              {expanded ? "Collapse" : `Show all ${lineCount} lines`}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
});

const MarkdownList = memo(function MarkdownList({
  ordered,
  start,
  items,
  notify,
}: {
  ordered: boolean;
  start: number;
  items: string[];
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const keyedItems = useMemo(() => {
    const seen = new Map<string, number>();
    let number = start;
    const keyed: { key: string; item: string; number: number }[] = [];
    for (const item of items) {
      const base = fingerprintText(item);
      const occurrence = (seen.get(base) ?? 0) + 1;
      seen.set(base, occurrence);
      keyed.push({ key: `${base}#${occurrence}`, item, number });
      number += 1;
    }
    return keyed;
  }, [items, start]);
  return (
    <View style={{ gap: tokens.spacing.xs }}>
      {keyedItems.map(({ key, item, number }) => (
        <View key={key} style={{ flexDirection: "row", gap: tokens.spacing.sm }}>
          <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
            {ordered ? `${number}.` : "•"}
          </Text>
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground, flex: 1 }}>
            <MemoInline text={item} notify={notify} />
          </Text>
        </View>
      ))}
    </View>
  );
});

const Quote = memo(function Quote({
  text,
  notify,
}: {
  text: string;
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: tokens.spacing.md }}>
      <View style={{ width: 2, backgroundColor: theme.colours.separator }} />
      <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground, flex: 1 }}>
        <MemoInline text={text} notify={notify} />
      </Text>
    </View>
  );
});

const Rule = memo(function Rule() {
  const theme = useTheme();
  return (
    <View style={{ height: tokens.dimensions.border, backgroundColor: theme.colours.separator }} />
  );
});

const MarkdownTable = memo(function MarkdownTable({
  headers,
  rows,
  notify,
}: {
  headers: string[];
  rows: string[][];
  notify?: ((text: string) => void) | undefined;
}) {
  const theme = useTheme();
  const cellWidth = 160;
  const keyedHeaders = useMemo(() => withStableKeys(headers, fingerprintText), [headers]);
  const keyedRows = useMemo(
    () =>
      withStableKeys(rows, (row) => fingerprintText(row.join("\n"))).map(({ key, value: row }) => ({
        key,
        cells: withStableKeys(row, fingerprintText),
      })),
    [rows],
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="markdown.table">
      <View>
        <View style={{ flexDirection: "row", backgroundColor: theme.colours.fill }}>
          {keyedHeaders.map(({ key, value: cell }) => (
            <Text
              key={key}
              style={{
                ...textStyle("body"),
                fontWeight: "600",
                color: theme.colours.foreground,
                width: cellWidth,
                padding: tokens.spacing.sm,
              }}
            >
              <MemoInline text={cell} notify={notify} />
            </Text>
          ))}
        </View>
        {keyedRows.map(({ key, cells }) => (
          <View key={key} style={{ flexDirection: "row" }}>
            {cells.map(({ key: cellKey, value: cell }) => (
              <Text
                key={cellKey}
                style={{
                  ...textStyle("body"),
                  color: theme.colours.foreground,
                  width: cellWidth,
                  padding: tokens.spacing.sm,
                  borderBottomWidth: tokens.dimensions.border,
                  borderBottomColor: theme.colours.separator,
                }}
              >
                <MemoInline text={cell} notify={notify} />
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

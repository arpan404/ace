import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { tokens, textStyle, useTheme } from "../theme.tsx";
import {
  codeLineCount,
  isCodeCollapsible,
  isOverInlineLimit,
  isSafeWebUrl,
  longMessagePreview,
  markdownBlocks,
  markdownInline,
  markdownPieces,
  visibleCodeText,
  type InlineSpan,
  type MarkdownBlock,
} from "./markdown.ts";
import { openWebLink } from "./links.ts";
import { copyCodeText } from "./clipboard.ts";

/**
 * Agent Markdown as native text (A05.02, iOS `MarkdownView` behavior).
 *
 * Inline syntax is a documented subset (see `markdown.ts`): bold, italic,
 * code and safe `http(s)` links. `ace://` stays literal; the Files screen
 * remains the only file route. Messages past `INLINE_MESSAGE_LIMIT` render a
 * bounded plain preview instead of parsing unbounded text per delta.
 * Blocks are keyed by position (as iOS keys by offset): appending only
 * changes the tail, while a mid-stream structural change (fence closes,
 * `---` becomes a rule) remounts downstream blocks, same as iOS.
 */
function shortFingerprint(text: string): string {
  let hash = 0;
  const scanned = Math.min(text.length, 64);
  for (let i = 0; i < scanned; i++) hash = (hash * 31 + text.charCodeAt(i)!) | 0;
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function blockFingerprint(block: MarkdownBlock): string {
  switch (block.kind) {
    case "paragraph":
      return `p:${shortFingerprint(block.text)}`;
    case "heading":
      return `h${block.level}:${shortFingerprint(block.text)}`;
    case "code":
      return `code:${block.language}:${shortFingerprint(block.text)}`;
    case "list":
      return `list:${block.ordered ? "o" : "u"}:${block.start}:${shortFingerprint(block.items.join("\n"))}`;
    case "quote":
      return `q:${shortFingerprint(block.text)}`;
    case "table":
      return `t:${shortFingerprint([...block.headers, ...block.rows.flat()].join("\n"))}`;
    case "rule":
      return "rule";
  }
}

function spanFingerprint(span: InlineSpan): string {
  return span.kind === "link"
    ? `link:${shortFingerprint(span.text)}:${shortFingerprint(span.url)}`
    : `${span.kind}:${shortFingerprint(span.text)}`;
}

/** Content-based keys with occurrence counting: append-only deltas keep
 * settled entries (and their state) while duplicates stay unique. */
function withStableKeys<T>(
  values: T[],
  fingerprint: (value: T) => string,
): { key: string; value: T }[] {
  const seen = new Map<string, number>();
  const keyed: { key: string; value: T }[] = [];
  for (const value of values) {
    const base = fingerprint(value);
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    keyed.push({ key: `${base}#${occurrence}`, value });
  }
  return keyed;
}
export const Markdown = memo(function Markdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const overLimit = isOverInlineLimit(text);
  const theme = useTheme();
  const blocks = useMemo(() => (overLimit ? [] : markdownBlocks(text)), [text, overLimit]);
  const preview = useMemo(() => (overLimit ? longMessagePreview(text) : ""), [text, overLimit]);
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
        >
          {preview}
        </Text>
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
  // Content keys (stronger than iOS offsets): append-only deltas keep
  // settled blocks; a structural change mid-stream remounts only what changed.
  const keyedBlocks = useMemo(() => withStableKeys(blocks, blockFingerprint), [blocks]);
  return (
    <View style={{ gap: tokens.spacing.sm }} testID="markdown">
      {keyedBlocks.map(({ key, value }) => (
        <BlockRow key={key} block={value} />
      ))}
      {streaming ? (
        <Text
          style={{ ...textStyle("body"), color: tokens.schemes.light.colours.mutedForeground }}
          accessibilityLabel="Streaming"
        >
          {"▍"}
        </Text>
      ) : null}
    </View>
  );
});

const BlockRow = memo(function BlockRow({ block }: { block: MarkdownBlock }) {
  switch (block.kind) {
    case "paragraph":
      return <Paragraph text={block.text} />;
    case "heading":
      return <Heading level={block.level} text={block.text} />;
    case "code":
      return <CodeBlock language={block.language} text={block.text} />;
    case "list":
      return <MarkdownList ordered={block.ordered} start={block.start} items={block.items} />;
    case "quote":
      return <Quote text={block.text} />;
    case "table":
      return <MarkdownTable headers={block.headers} rows={block.rows} />;
    case "rule":
      return <Rule />;
  }
});

/** One run of prose, flowing inside a single Text so sentence pieces wrap. */
const Paragraph = memo(function Paragraph({ text }: { text: string }) {
  const theme = useTheme();
  const pieces = useMemo(() => markdownPieces(text), [text]);
  const keyedPieces = useMemo(() => withStableKeys(pieces, shortFingerprint), [pieces]);
  return (
    <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
      {keyedPieces.map(({ key, value }) => (
        <Piece key={key} text={value} />
      ))}
    </Text>
  );
});

const Piece = memo(function Piece({ text }: { text: string }) {
  const theme = useTheme();
  const spans = useMemo(() => markdownInline(text), [text]);
  return (
    <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
      <Inline spans={spans} />
    </Text>
  );
});

function MemoInline({ text }: { text: string }) {
  const spans = useMemo(() => markdownInline(text), [text]);
  return <Inline spans={spans} />;
}

const Heading = memo(function Heading({ level, text }: { level: number; text: string }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        ...textStyle(level <= 2 ? "title" : "rowTitle"),
        color: theme.colours.foreground,
      }}
      accessibilityRole="header"
    >
      <MemoInline text={text} />
    </Text>
  );
});

function Inline({ spans }: { spans: InlineSpan[] }) {
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
                  void openWebLink(span.url);
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

const CodeBlock = memo(function CodeBlock({ language, text }: { language: string; text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsible = useMemo(() => isCodeCollapsible(text), [text]);
  const shown = useMemo(() => visibleCodeText(text, expanded), [text, expanded]);
  const lineCount = useMemo(() => codeLineCount(text), [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
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
            if (copyCodeText(text)) setCopied(true);
          }}
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          style={{
            paddingHorizontal: tokens.spacing.sm,
            minHeight: tokens.spacing.xxxl,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...textStyle("caption"), color: theme.colours.subtleForeground }}>
            {copied ? "Copied" : "Copy"}
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
}: {
  ordered: boolean;
  start: number;
  items: string[];
}) {
  const theme = useTheme();
  const keyedItems = useMemo(() => {
    const seen = new Map<string, number>();
    let number = start;
    const keyed: { key: string; item: string; number: number }[] = [];
    for (const item of items) {
      const base = shortFingerprint(item);
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
            <MemoInline text={item} />
          </Text>
        </View>
      ))}
    </View>
  );
});

const Quote = memo(function Quote({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: tokens.spacing.md }}>
      <View style={{ width: 2, backgroundColor: theme.colours.separator }} />
      <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground, flex: 1 }}>
        <MemoInline text={text} />
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
}: {
  headers: string[];
  rows: string[][];
}) {
  const theme = useTheme();
  const cellWidth = 160;
  const keyedHeaders = useMemo(() => withStableKeys(headers, shortFingerprint), [headers]);
  const keyedRows = useMemo(
    () =>
      withStableKeys(rows, (row) => shortFingerprint(row.join("\n"))).map(
        ({ key, value: row }) => ({
          key,
          cells: withStableKeys(row, shortFingerprint),
        }),
      ),
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
              <MemoInline text={cell} />
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
                <MemoInline text={cell} />
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

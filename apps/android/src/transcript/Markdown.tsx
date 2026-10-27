import { memo, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { tokens, textStyle, useTheme } from "../theme.tsx";
import {
  isCodeCollapsible,
  markdownBlocks,
  markdownInline,
  markdownPieces,
  visibleCodeText,
  codeLineCount,
  type InlineSpan,
  type MarkdownBlock,
} from "./markdown.ts";
import { copyCodeText } from "./clipboard.ts";

/**
 * Agent Markdown as native text (A05.02, iOS `MarkdownView` parity).
 *
 * Blocks are memoized by position and long paragraphs render in sentence
 * pieces, so a streamed delta only re-lays-out its own row's last piece.
 * Code blocks carry a language + Copy header and collapse past 20 lines;
 * tables scroll sideways; malformed input stays readable as prose.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  const blocks = useMemo(() => markdownBlocks(text), [text]);
  if (text === "") return null;
  // Blocks are keyed by position, as iOS keys them by offset: a streamed
  // delta only appends or changes the tail, so settled blocks keep their
  // identity (and selection) instead of re-rendering on every delta.
  return (
    <View style={{ gap: tokens.spacing.sm }} testID="markdown">
      {blocks.map((block, index) => (
        <BlockRow key={index} block={block} />
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

/** One run of prose, memoized so an unchanged streaming piece never re-parses. */
const Paragraph = memo(function Paragraph({ text }: { text: string }) {
  const pieces = useMemo(() => markdownPieces(text), [text]);
  return (
    <View>
      {pieces.map((piece, index) => (
        <Piece key={index} text={piece} />
      ))}
    </View>
  );
});

const Piece = memo(function Piece({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text style={{ ...textStyle("body"), color: theme.colours.foreground }}>
      <Inline spans={markdownInline(text)} />
    </Text>
  );
});

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
      <Inline spans={markdownInline(text)} />
    </Text>
  );
});

function Inline({ spans }: { spans: InlineSpan[] }) {
  const theme = useTheme();
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case "strong":
            return (
              <Text key={index} style={{ fontWeight: "700" }}>
                {span.text}
              </Text>
            );
          case "emphasis":
            return (
              <Text key={index} style={{ fontStyle: "italic" }}>
                {span.text}
              </Text>
            );
          case "code":
            return (
              <Text
                key={index}
                style={{
                  ...textStyle("code"),
                  backgroundColor: theme.colours.fill,
                }}
              >
                {span.text}
              </Text>
            );
          case "link":
            return (
              <Text key={index} style={{ color: theme.colours.accent }}>
                {span.text}
              </Text>
            );
          default:
            return <Text key={index}>{span.text}</Text>;
        }
      })}
    </>
  );
}

const CodeBlock = memo(function CodeBlock({ language, text }: { language: string; text: string }) {
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const collapsible = isCodeCollapsible(text);
  const shown = visibleCodeText(text, expanded);
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
              {expanded ? "Collapse" : `Show all ${codeLineCount(text)} lines`}
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
  return (
    <View style={{ gap: tokens.spacing.xs }}>
      {items.map((item, index) => (
        <View key={index} style={{ flexDirection: "row", gap: tokens.spacing.sm }}>
          <Text style={{ ...textStyle("body"), color: theme.colours.mutedForeground }}>
            {ordered ? `${start + index}.` : "•"}
          </Text>
          <Text style={{ ...textStyle("body"), color: theme.colours.foreground, flex: 1 }}>
            <Inline spans={markdownInline(item)} />
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
        <Inline spans={markdownInline(text)} />
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
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} testID="markdown.table">
      <View>
        <View style={{ flexDirection: "row", backgroundColor: theme.colours.fill }}>
          {headers.map((cell, index) => (
            <Text
              key={index}
              style={{
                ...textStyle("body"),
                fontWeight: "600",
                color: theme.colours.foreground,
                width: cellWidth,
                padding: tokens.spacing.sm,
              }}
            >
              <Inline spans={markdownInline(cell)} />
            </Text>
          ))}
        </View>
        {rows.map((row, rowIndex) => (
          <View key={rowIndex} style={{ flexDirection: "row" }}>
            {row.map((cell, cellIndex) => (
              <Text
                key={cellIndex}
                style={{
                  ...textStyle("body"),
                  color: theme.colours.foreground,
                  width: cellWidth,
                  padding: tokens.spacing.sm,
                  borderBottomWidth: tokens.dimensions.border,
                  borderBottomColor: theme.colours.separator,
                }}
              >
                <Inline spans={markdownInline(cell)} />
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

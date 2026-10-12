import type { Item } from "@ace/protocol";

export const visualizationFallback = "Visualization — view on desktop or web";

export interface TranscriptRowContent {
  text: string;
  /** Secondary muted line under the text, empty when the row has none. */
  detail: string;
  user: boolean;
  /** Quiet rows render in the caption style. */
  quiet: boolean;
}

/** What a transcript item shows on Android; HTML visualizations can't render here yet. */
export function transcriptRowContent(item: Item): TranscriptRowContent {
  const row = { text: "", detail: "", user: false, quiet: false };
  if (item.type === "message") {
    row.text = item.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    row.user = item.role === "user";
  } else if (item.type === "html") {
    row.text = item.visualization.title;
    row.detail = visualizationFallback;
    row.quiet = true;
  } else if (item.type === "reasoning") row.text = "Thinking…";
  else if (item.type === "tool_call") {
    row.text = `${item.call.title} · ${item.call.status}`;
    row.quiet = true;
  } else if (item.type === "notice") row.text = item.text;
  else if (item.type === "delegation.started") row.text = `${item.title} · ${item.status.state}`;
  else row.text = item.type.replaceAll("_", " ");
  return row;
}

import type { Item } from "@ace/protocol";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";

export function ReasoningItemView(props: { item: Extract<Item, { type: "reasoning" }> }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        {props.item.complete ? "Thought" : "Thinking…"}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 border-l pl-3 text-xs whitespace-pre-wrap text-muted-foreground">
        {props.item.text}
      </CollapsibleContent>
    </Collapsible>
  );
}
export function NoticeItemView(props: { item: Extract<Item, { type: "notice" }> }) {
  const tone = props.item.level === "error" ? "text-status-failed" : "text-muted-foreground";
  return (
    <Marker>
      <MarkerContent className={tone}>{props.item.text}</MarkerContent>
    </Marker>
  );
}
export function CompactionItemView() {
  return (
    <Marker variant="separator">
      <MarkerContent>Context compacted</MarkerContent>
    </Marker>
  );
}
export function ArtifactItemView(props: { item: Extract<Item, { type: "artifact" }> }) {
  return (
    <Marker>
      <MarkerContent>Artifact: {props.item.path}</MarkerContent>
    </Marker>
  );
}

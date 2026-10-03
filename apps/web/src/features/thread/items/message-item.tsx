import type { Item } from "@ace/protocol";
import { Bubble, BubbleContent } from "@/components/ui/bubble.tsx";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message.tsx";

type MessageItem = Extract<Item, { type: "message" }>;

export function MessageItemView(props: { item: MessageItem; agentName?: string | undefined }) {
  const { item } = props;
  const user = item.role === "user";
  const text = item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  return (
    <Message align={user ? "end" : "start"}>
      <MessageContent>
        {!user && props.agentName && <MessageHeader>{props.agentName}</MessageHeader>}
        <Bubble variant={user ? "secondary" : "ghost"} align={user ? "end" : "start"}>
          <BubbleContent className="whitespace-pre-wrap">
            {text}
            {!item.complete && (
              <span
                aria-label="Streaming"
                className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-baseline"
              />
            )}
          </BubbleContent>
        </Bubble>
        {item.parts.map((part) =>
          part.type === "file" ? (
            <span key={part.path} className="text-xs text-muted-foreground">
              {part.path}
            </span>
          ) : null,
        )}
      </MessageContent>
    </Message>
  );
}

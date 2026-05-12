import { ChevronDownIcon } from "lucide-react";
import { memo, type ComponentProps, type ReactNode, type Ref } from "react";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

import { MessagesTimeline } from "./MessagesTimeline";

type MessagesContainerProps = ComponentProps<"div">;

export const ChatMessagesPane = memo(function ChatMessagesPane({
  loadingNotice,
  messagesContainerRef,
  messagesTimelineProps,
  onMessagesClickCapture,
  onMessagesPointerCancel,
  onMessagesPointerDown,
  onMessagesPointerUp,
  onMessagesScroll,
  onMessagesTouchEnd,
  onMessagesTouchMove,
  onMessagesTouchStart,
  onMessagesWheel,
  scrollMessagesToBottom,
  showScrollToBottom,
  timelineKey,
}: {
  loadingNotice?: ReactNode;
  messagesContainerRef: Ref<HTMLDivElement>;
  messagesTimelineProps: ComponentProps<typeof MessagesTimeline>;
  onMessagesClickCapture: MessagesContainerProps["onClickCapture"];
  onMessagesPointerCancel: MessagesContainerProps["onPointerCancel"];
  onMessagesPointerDown: MessagesContainerProps["onPointerDown"];
  onMessagesPointerUp: MessagesContainerProps["onPointerUp"];
  onMessagesScroll: MessagesContainerProps["onScroll"];
  onMessagesTouchEnd: MessagesContainerProps["onTouchEnd"];
  onMessagesTouchMove: MessagesContainerProps["onTouchMove"];
  onMessagesTouchStart: MessagesContainerProps["onTouchStart"];
  onMessagesWheel: MessagesContainerProps["onWheel"];
  scrollMessagesToBottom: (behavior?: ScrollBehavior) => void;
  showScrollToBottom: boolean;
  timelineKey: string;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea
        ref={messagesContainerRef}
        className="flex-1 px-3 py-3 sm:px-5 sm:py-4"
        onScroll={onMessagesScroll}
        onClickCapture={onMessagesClickCapture}
        onWheel={onMessagesWheel}
        onPointerDown={onMessagesPointerDown}
        onPointerUp={onMessagesPointerUp}
        onPointerCancel={onMessagesPointerCancel}
        onTouchStart={onMessagesTouchStart}
        onTouchMove={onMessagesTouchMove}
        onTouchEnd={onMessagesTouchEnd}
        onTouchCancel={onMessagesTouchEnd}
      >
        {loadingNotice}
        <MessagesTimeline key={timelineKey} {...messagesTimelineProps} />
      </ScrollArea>

      {showScrollToBottom && (
        <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => scrollMessagesToBottom()}
            className="pointer-events-auto rounded-full bg-card"
            aria-label="Scroll to bottom"
          >
            <ChevronDownIcon className="size-3.5" />
            Scroll to bottom
          </Button>
        </div>
      )}
    </div>
  );
});

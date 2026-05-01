import { ChevronDownIcon } from "lucide-react";
import { memo, type ComponentProps, type ReactNode, type Ref } from "react";

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
      <div
        ref={messagesContainerRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-3 sm:px-5 sm:py-4"
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
      </div>

      {showScrollToBottom && (
        <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
          <button
            type="button"
            onClick={() => scrollMessagesToBottom()}
            className="pointer-events-auto flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-muted-foreground text-xs transition-colors duration-150 hover:bg-accent hover:text-foreground"
          >
            <ChevronDownIcon className="size-3.5" />
            Scroll to bottom
          </button>
        </div>
      )}
    </div>
  );
});

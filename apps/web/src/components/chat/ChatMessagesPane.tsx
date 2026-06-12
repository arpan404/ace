import { ChevronDownIcon } from "lucide-react";
import { memo, type ComponentProps, type Ref } from "react";
import { cn } from "~/lib/utils";
import { APP_FLOATING_CHIP_CLASS_NAME } from "~/lib/appChrome";
import { Button } from "~/components/ui/button";
import { ScrollArea } from "~/components/ui/scroll-area";

import { MessagesTimeline } from "./MessagesTimeline";

type MessagesContainerProps = ComponentProps<"div">;

export const ChatMessagesPane = memo(function ChatMessagesPane({
  messagesContainerRef,
  messagesTimelineProps,
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
  messagesContainerRef: Ref<HTMLDivElement>;
  messagesTimelineProps: ComponentProps<typeof MessagesTimeline>;
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
        className="flex-1 px-3 sm:px-5"
        viewportRef={messagesContainerRef}
        viewportProps={{
          className: "pe-2.5",
          onScroll: onMessagesScroll,
          onWheel: onMessagesWheel,
          onPointerDown: onMessagesPointerDown,
          onPointerUp: onMessagesPointerUp,
          onPointerCancel: onMessagesPointerCancel,
          onTouchStart: onMessagesTouchStart,
          onTouchMove: onMessagesTouchMove,
          onTouchEnd: onMessagesTouchEnd,
          onTouchCancel: onMessagesTouchEnd,
        }}
      >
        <MessagesTimeline key={timelineKey} {...messagesTimelineProps} />
      </ScrollArea>

      {showScrollToBottom && (
        <div className="pointer-events-none absolute bottom-1 left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => scrollMessagesToBottom()}
            className={cn(
              APP_FLOATING_CHIP_CLASS_NAME,
              "pointer-events-auto h-8 w-8 rounded-full p-0 transition-colors hover:bg-accent/75 hover:text-accent-foreground active:bg-accent/80",
            )}
            aria-label="Scroll to bottom"
          >
            <ChevronDownIcon className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
});

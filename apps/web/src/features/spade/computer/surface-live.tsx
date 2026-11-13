import type { SpadeSurface } from "@ace/ui-core/spade-chat";
import { lazy, Suspense } from "react";
import { openExternal } from "@/boot/open-external.ts";
import { Button } from "@/components/ui/button.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { loadBotScreen } from "@/features/computer-use/index.ts";
import { loadBotBrowser } from "@/features/panels/index.ts";
import { message } from "../spade-screen-parts.tsx";
import { useBotStreams, type BotPictureSurface } from "./bot-streams.ts";
import { StreamPicture } from "./stream-picture.tsx";

const BotBrowser = lazy(loadBotBrowser);
const BotScreen = lazy(loadBotScreen);

/** One quiet sentence in the surface's place. */
const note = (text: string) => (
  <p className="grid h-full place-items-center px-6 text-center text-ui text-muted-foreground">
    {text}
  </p>
);

/**
 * A bot's browser or screen, live. Where the app supplies pictures (`BotStreams`, the fake world)
 * they show; otherwise ace's own views: the browser's page view on the bot's hidden thread and
 * tab, or computer use's live view of the session that thread started. A tab in the person's own
 * Chrome isn't streamed: it offers to open there. The person's input goes through only while they
 * drive. A bot on another machine is watched from that machine.
 */
export function SurfaceLive(props: {
  machine: { key: string; name: string; primary: boolean };
  bot: { id: string; name: string };
  kind: BotPictureSurface;
  surface: SpadeSurface | undefined;
  /** The bot's hidden ace thread, once Spade knows it. */
  threadId: string | undefined;
  driving: boolean;
  label: string;
}) {
  const streams = useBotStreams();
  const toast = useToast();
  const { kind, bot } = props;
  const words = kind === "browser" ? "browser" : "screen";
  if (streams)
    return (
      <StreamPicture
        surfaceKey={{ machine: props.machine.key, bot: bot.id, surface: kind }}
        driving={props.driving}
        label={props.label}
      />
    );
  if (!props.machine.primary) return note(`${bot.name}'s ${words} shows on ${props.machine.name}.`);
  if (!props.threadId) return note(`${bot.name} hasn't opened its ${words} yet.`);
  if (kind === "browser" && props.surface?.backend === "user") {
    const url = props.surface.url;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-ui text-muted-foreground">
          {`${bot.name} is using a tab in your own Chrome.`}
        </p>
        {url && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void openExternal(url).catch((error: unknown) =>
                toast.error({ title: "Couldn't open it in Chrome", description: message(error) }),
              )
            }
          >
            Open in Chrome
          </Button>
        )}
      </div>
    );
  }
  const waiting = `Waiting for ${bot.name}'s ${words}…`;
  return (
    <Suspense fallback={note(waiting)}>
      {kind === "browser" ? (
        <BotBrowser
          threadId={props.threadId}
          tabId={props.surface?.tabId}
          driving={props.driving}
          waiting={waiting}
        />
      ) : (
        <BotScreen
          threadId={props.threadId}
          driving={props.driving}
          label={props.label}
          waiting={waiting}
          onProblem={(error) =>
            toast.error({ title: "That didn't reach the screen", description: message(error) })
          }
        />
      )}
    </Suspense>
  );
}

import { spadeHostOf, type SpadeSurface } from "@ace/ui-core/spade-chat";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { keyInput, pointerGesture, windowPoint } from "@/features/computer-use/index.ts";
import { cn } from "@/lib/cn.ts";
import { message } from "../spade-screen-parts.tsx";
import { useBotStreams, type BotPicture, type BotSurfaceKey } from "./bot-streams.ts";

/** A scroll in whole points, within what may be sent at once. */
const clamp = (value: number) => Math.max(-1000, Math.min(1000, Math.round(value)));

/** The newest picture of a bot's browser or screen, or undefined until one arrives. */
export function useBotPicture(key: BotSurfaceKey | undefined): {
  picture: BotPicture | undefined;
  available: boolean;
} {
  const streams = useBotStreams();
  const [picture, setPicture] = useState<BotPicture>();
  const id = key ? `${key.machine}/${key.bot}/${key.surface}` : "";
  useEffect(() => {
    setPicture(undefined);
    if (!streams || !key) return;
    return streams.watch(key, setPicture);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `id` names the key
  }, [streams, id]);
  return { picture, available: streams !== undefined };
}

/**
 * A bot's browser (under its address) or screen, live. While the person drives, clicks, drags,
 * scrolls and keys over the picture go to it through ace's browser and computer-use input;
 * while the bot drives it only shows.
 */
export function SurfacePicture(props: {
  surfaceKey: BotSurfaceKey;
  surface: SpadeSurface | undefined;
  driving: boolean;
  label: string;
}) {
  const streams = useBotStreams();
  const toast = useToast();
  const { picture, available } = useBotPicture(props.surfaceKey);
  const image = useRef<HTMLImageElement>(null);
  const press = useRef<{
    page: { x: number; y: number };
    at: { x: number; y: number };
    button: number;
    time: number;
  }>(undefined);
  const send = (input: Parameters<NonNullable<typeof streams>["input"]>[1]) =>
    void streams
      ?.input(props.surfaceKey, input)
      .catch((error: unknown) =>
        toast.error({ title: "That didn't reach the computer", description: message(error) }),
      );
  const point = (event: { clientX: number; clientY: number }) => {
    const box = image.current?.getBoundingClientRect();
    if (!box || !picture) return undefined;
    return windowPoint(
      { x: event.clientX, y: event.clientY },
      { box, width: picture.width, height: picture.height, scale: 1 },
    );
  };
  const browser = props.surfaceKey.surface === "browser";
  return (
    <div className="flex h-full min-h-0 flex-col gap-0 p-4">
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-code shadow-[inset_0_0_0_1px_var(--border)]",
        )}
      >
        {browser && <AddressBar url={props.surface?.url} />}
        <div
          role="img"
          aria-label={props.label}
          tabIndex={props.driving ? 0 : -1}
          data-driving={props.driving || undefined}
          onPointerDown={(event) => {
            if (!props.driving) return;
            const at = point(event);
            if (!at) return;
            event.currentTarget.focus();
            press.current = {
              page: { x: event.clientX, y: event.clientY },
              at,
              button: event.button,
              time: event.timeStamp,
            };
          }}
          onPointerUp={(event) => {
            const down = press.current;
            press.current = undefined;
            if (!props.driving || !down) return;
            const gesture = pointerGesture(
              down,
              { page: { x: event.clientX, y: event.clientY }, at: point(event) },
              event.timeStamp - down.time,
            );
            if (gesture) send(gesture);
          }}
          onWheel={(event) => {
            if (!props.driving) return;
            const at = point(event);
            if (!at) return;
            send({
              kind: "scroll",
              ...at,
              dx: clamp(event.deltaX),
              dy: clamp(event.deltaY),
            });
          }}
          onKeyDown={(event) => {
            if (!props.driving) return;
            const input = keyInput(event);
            if (!input) return;
            event.preventDefault();
            send(input);
          }}
          className={cn(
            "relative grid min-h-0 flex-1 place-items-center bg-background focus-ring-inset",
            props.driving && "cursor-default",
          )}
        >
          {picture ? (
            <img
              ref={image}
              src={picture.src}
              alt=""
              draggable={false}
              className="size-full object-contain object-top select-none"
            />
          ) : (
            <p className="px-6 text-center text-ui text-muted-foreground">
              {available
                ? "Waiting for the picture…"
                : "The live picture isn't available here yet."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** The page's address: its host, then the rest muted. Read-only: the bot or the person browses. */
function AddressBar(props: { url: string | undefined }) {
  const host = spadeHostOf(props.url);
  let rest = "";
  try {
    if (props.url) {
      const url = new URL(props.url);
      rest = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
    }
  } catch {
    rest = "";
  }
  const secure = props.url?.startsWith("https:");
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
      {secure && (
        <Icon icon={LockSimpleIcon} size={14} className="shrink-0 text-muted-foreground" />
      )}
      <p
        aria-label="Address"
        className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate rounded-md bg-secondary px-2.5 py-1 text-ui"
      >
        <span className="text-foreground">{host ?? props.url ?? "No page open"}</span>
        <span className="truncate text-muted-foreground">{rest}</span>
      </p>
    </div>
  );
}

import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/ui/toast.tsx";
import {
  AgentCursor,
  keyInput,
  pointerGesture,
  windowPoint,
} from "@/features/computer-use/index.ts";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "../spade-face.tsx";
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
  // Kept with the surface it shows, so another surface never shows the last one's picture.
  const [shown, setShown] = useState<{ id: string; picture: BotPicture }>();
  const id = key ? `${key.machine}/${key.bot}/${key.surface}` : "";
  useEffect(() => {
    if (!streams || !key) return;
    return streams.watch(key, (picture) => setShown({ id, picture }));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `id` names the key
  }, [streams, id]);
  return {
    picture: shown?.id === id ? shown.picture : undefined,
    available: streams !== undefined,
  };
}

/**
 * Pictures the app supplies (`BotStreams`, the fake world's): the newest one, with the bot's
 * pointer where it last acted, and while the person may act (cowork, or exclusive while they
 * drive) clicks, drags, scrolls and keys over it sent as computer-use input.
 */
export function StreamPicture(props: {
  surfaceKey: BotSurfaceKey;
  /** The person's input goes in now. */
  mayAct: boolean;
  label: string;
  bot: { name: string; avatar: SpadeAvatar };
}) {
  const streams = useBotStreams();
  const toast = useToast();
  const { picture } = useBotPicture(props.surfaceKey);
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
  // A page sits right under its address bar; a screen centres in its pane.
  const top = props.surfaceKey.surface === "browser";
  const point = (event: { clientX: number; clientY: number }) => {
    const rect = image.current?.getBoundingClientRect();
    if (!rect || !picture) return undefined;
    // Drawn at the top, the picture's box is only as tall as the picture at its fitted scale.
    const fit = Math.min(rect.width / picture.width, rect.height / picture.height);
    const box = top
      ? { left: rect.left, top: rect.top, width: rect.width, height: picture.height * fit }
      : rect;
    return windowPoint(
      { x: event.clientX, y: event.clientY },
      { box, width: picture.width, height: picture.height, scale: 1 },
    );
  };
  return (
    <div
      // While the person may act it takes their clicks and keys, as an app in the page.
      role="application"
      aria-label={props.label}
      tabIndex={props.mayAct ? 0 : undefined}
      data-acting={props.mayAct || undefined}
      onPointerDown={(event) => {
        if (!props.mayAct) return;
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
        if (!props.mayAct || !down) return;
        const gesture = pointerGesture(
          down,
          { page: { x: event.clientX, y: event.clientY }, at: point(event) },
          event.timeStamp - down.time,
        );
        if (gesture) send(gesture);
      }}
      onWheel={(event) => {
        if (!props.mayAct) return;
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
        if (!props.mayAct) return;
        const input = keyInput(event);
        if (!input) return;
        event.preventDefault();
        send(input);
      }}
      className={cn(
        "relative grid min-h-0 flex-1 place-items-center bg-background focus-ring-inset",
        props.mayAct && "cursor-default",
      )}
    >
      {picture ? (
        <img
          ref={image}
          src={picture.src}
          alt=""
          draggable={false}
          className={cn("size-full object-contain select-none", top && "object-top")}
        />
      ) : (
        <p className="px-6 text-center text-ui text-muted-foreground">Waiting for the picture…</p>
      )}
      {picture && (
        <AgentCursor
          pointer={picture.pointer}
          width={picture.width}
          height={picture.height}
          name={props.bot.name}
          mark={<SpadeFace avatar={props.bot.avatar} size={14} />}
          align={top ? "top" : "center"}
        />
      )}
    </div>
  );
}

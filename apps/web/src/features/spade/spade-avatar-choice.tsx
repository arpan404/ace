import {
  allowedFaceValues,
  botFaceFieldLabels,
  botFaceFieldOrder,
  botFaceFields,
  botFacePartField,
  changeFace,
  shuffleFace,
  stepFace,
  type BotFace as BotFaceModel,
  type BotFaceField,
  type BotFaceValue,
} from "@ace/ui-core/bot-face";
import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { cn } from "@/lib/cn.ts";
import { SpadeFace } from "./spade-face.tsx";

/** The face as the person is choosing it: a character face, a new picture, or the one it has. */
export type AvatarDraft =
  | { kind: "face"; face: BotFaceModel; raw?: Record<string, unknown> | undefined }
  | { kind: "image"; data: string }
  | { kind: "current"; avatar: SpadeAvatar };

const imageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const maxImageBytes = 3_750_000;
const big = 132;
const mini = 30;

/** A draft as a face to edit, when it is one (a character, chosen or kept). */
export function draftFace(draft: AvatarDraft): BotFaceModel | undefined {
  if (draft.kind === "face") return draft.face;
  if (draft.kind === "current" && draft.avatar.kind === "character") return draft.avatar.face;
  return undefined;
}

const reduced = () => document.documentElement.hasAttribute("data-reduce-motion");

/**
 * The editor's live face: it follows the pointer, blinks now and then, hops when it changes,
 * and a click on one of its parts steps that part.
 */
function LiveFace(props: { face: BotFaceModel; onStep(field: BotFaceField): void }) {
  const box = useRef<HTMLSpanElement>(null);
  const [look, setLook] = useState<{ x: number; y: number }>();
  const [cue, setCue] = useState<{ kind: "blink" | "hop"; at: number }>();
  // A new face hops once: noticed while rendering, so the hop starts with the new face.
  const [drawn, setDrawn] = useState(props.face);
  if (drawn !== props.face) {
    setDrawn(props.face);
    setCue((last) => ({ kind: "hop", at: (last?.at ?? 0) + 1 }));
  }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const blink = () => {
      if (!reduced()) setCue((last) => ({ kind: "blink", at: (last?.at ?? 0) + 1 }));
      timer = setTimeout(blink, 2600 + Math.random() * 3200);
    };
    timer = setTimeout(blink, 2000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    const follow = (event: PointerEvent) => {
      const rect = box.current?.getBoundingClientRect();
      if (!rect?.width || reduced()) return;
      const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width;
      const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height;
      const length = Math.hypot(dx, dy) || 1;
      const reach = Math.min(1, length * 1.5);
      setLook({
        x: Math.round((dx / length) * reach * 100) / 100,
        y: Math.round((dy / length) * reach * 100) / 100,
      });
    };
    const rest = () => setLook(undefined);
    document.addEventListener("pointermove", follow);
    document.documentElement.addEventListener("pointerleave", rest);
    return () => {
      document.removeEventListener("pointermove", follow);
      document.documentElement.removeEventListener("pointerleave", rest);
    };
  }, []);
  return (
    <span ref={box} className="grid">
      <BotFace
        face={props.face}
        size={big}
        look={look}
        cue={cue}
        onPart={(part) => {
          const field = botFacePartField[part];
          if (field) props.onStep(field);
        }}
      />
    </span>
  );
}

/** One part's options: the bot's own face with just that part changed, as radio buttons. */
function PartRow(props: {
  field: BotFaceField;
  face: BotFaceModel;
  chosen: boolean;
  /** Options wrap onto more lines rather than scroll (a popover's narrow column). */
  wrap?: boolean;
  onChange(face: BotFaceModel): void;
}) {
  const { field, face } = props;
  const values: readonly string[] =
    field === "body" || field === "pair" ? botFaceFields[field] : allowedFaceValues(field, face);
  if (values.length < 2) return null;
  const label = botFaceFieldLabels[field];
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-ui text-muted-foreground">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className={cn(
          "-mx-1 flex min-w-0 px-1 py-0.5",
          props.wrap ? "flex-wrap" : "overflow-x-auto @lg:flex-wrap @lg:overflow-visible",
        )}
      >
        {values.map((value) => {
          const option = changeFace(face, field, value as BotFaceValue<typeof field>);
          const on = props.chosen && face[field] === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={`${label}: ${value}`}
              onClick={() => props.onChange(option)}
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
                on && "shadow-[0_0_0_1.5px_var(--foreground)]",
              )}
            >
              <BotFace face={option} size={mini} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Picks a picture for the face, checked before it's read; `problem` says why one was refused. */
function usePictureUpload(onChange: (value: AvatarDraft) => void) {
  const file = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string>();
  const upload = (chosen: File | undefined) => {
    if (!chosen) return;
    if (!imageTypes.has(chosen.type)) return setProblem("Use a PNG, JPEG, GIF or WebP picture.");
    if (chosen.size > maxImageBytes) return setProblem("Use a picture smaller than 3.75 MB.");
    setProblem(undefined);
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") onChange({ kind: "image", data: reader.result });
    });
    reader.readAsDataURL(chosen);
  };
  const pick = () => file.current?.click();
  const input = (
    <input
      ref={file}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp"
      aria-label="Picture"
      className="hidden"
      onChange={(event) => {
        upload(event.target.files?.[0]);
        event.target.value = "";
      }}
    />
  );
  const said = problem && (
    <p role="alert" className="text-xs text-destructive">
      {problem}
    </p>
  );
  return { pick, input, said };
}

/** The stored fields of a draft's face that ace doesn't know, kept for the next save. */
const rawOf = (value: AvatarDraft) =>
  value.kind === "face"
    ? value.raw
    : value.kind === "current" && value.avatar.kind === "character"
      ? value.avatar.raw
      : undefined;

/**
 * A bot's face: its character, edited directly (the big face follows the pointer, blinks, and
 * steps a part when clicked; each option is the bot's own face with that one change, and
 * options that don't go with the rest are hidden), Shuffle for a new one in colours no other bot
 * wears where it can, or an uploaded picture (PNG, JPEG, GIF or WebP up to 3.75 MB).
 */
export function AvatarChoice(props: {
  value: AvatarDraft;
  /** The face to start from when the person leaves a picture for a face. */
  fallback: BotFaceModel;
  /** Colour pairs other bots wear, which Shuffle avoids while it can. */
  takenPairs: readonly string[];
  onChange(value: AvatarDraft): void;
}) {
  const picture = usePictureUpload(props.onChange);
  // The creature and its colours first; More shows every other part.
  const [more, setMore] = useState(false);
  const { value } = props;
  const face = draftFace(value);
  const raw = rawOf(value);
  const setFace = (next: BotFaceModel) => props.onChange({ kind: "face", face: next, raw });
  const shown = face ?? props.fallback;
  return (
    <div className="flex flex-col gap-1.5 @container">
      <div className="flex flex-col gap-4 @lg:flex-row @lg:items-start">
        <div className="flex flex-col items-center gap-2 self-center @lg:self-start">
          <div className="grid size-40 place-items-center rounded-lg bg-fill">
            {face ? (
              <LiveFace face={face} onStep={(field) => setFace(stepFace(face, field))} />
            ) : value.kind === "image" ? (
              <img alt="" src={value.data} className="size-33 rounded-full object-cover" />
            ) : (
              value.kind === "current" && <SpadeFace avatar={value.avatar} size={big} />
            )}
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setFace(shuffleFace(Math.random, shown, props.takenPairs))}
            >
              Shuffle
            </Button>
            {face ? (
              <Button size="sm" variant="ghost" onClick={picture.pick}>
                Upload picture
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setFace(props.fallback)}>
                Use a face
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={more}
              onClick={() => setMore((open) => !open)}
            >
              {more ? "Less" : "More"}
            </Button>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {(more ? botFaceFieldOrder : botFaceFieldOrder.slice(0, 2)).map((field) => (
            <PartRow
              key={field}
              field={field}
              face={shown}
              chosen={face !== undefined}
              onChange={setFace}
            />
          ))}
        </div>
      </div>
      {picture.input}
      {picture.said}
    </div>
  );
}

/** The parts under More, named in the fold that opens them ("Ears, marking, eyes…"). */
const finerParts = botFaceFieldOrder.slice(2);
const finerWords = finerParts
  .map((field, at) => {
    const label = botFaceFieldLabels[field];
    return at === 0 ? label : label.toLowerCase();
  })
  .join(", ");

/**
 * A bot's face at the top of a new bot's conversation (docs/design/spade.md §5), changed from the
 * face itself: it opens a popover with Shuffle and Upload picture, the creature and its colour,
 * and the finer parts one fold away. Each option is the bot's own face with that one change.
 */
export function AvatarPopover(props: {
  value: AvatarDraft;
  /** The face to start from when the person leaves a picture for a face. */
  fallback: BotFaceModel;
  takenPairs: readonly string[];
  /** Its side in px. */
  size: number;
  onChange(value: AvatarDraft): void;
}) {
  const picture = usePictureUpload(props.onChange);
  const [more, setMore] = useState(false);
  const { value } = props;
  const face = draftFace(value);
  const raw = rawOf(value);
  const setFace = (next: BotFaceModel) => props.onChange({ kind: "face", face: next, raw });
  const shown = face ?? props.fallback;
  return (
    <Popover>
      <PopoverTrigger
        aria-label="Change face"
        className="grid shrink-0 place-items-center rounded-full transition-[filter] duration-(--motion-fast) focus-ring hover:brightness-110 data-popup-open:brightness-110"
      >
        {value.kind === "image" ? (
          <img
            alt=""
            src={value.data}
            className="rounded-full object-cover"
            style={{ width: props.size, height: props.size }}
          />
        ) : value.kind === "current" && !face ? (
          <SpadeFace avatar={value.avatar} size={props.size} />
        ) : (
          <BotFace face={shown} size={props.size} />
        )}
      </PopoverTrigger>
      <PopoverContent
        align="center"
        aria-label="Face"
        className="flex w-80 max-w-[calc(100vw-1.5rem)] flex-col gap-2 p-2"
      >
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFace(shuffleFace(Math.random, shown, props.takenPairs))}
          >
            Shuffle
          </Button>
          {face ? (
            <Button size="sm" variant="ghost" onClick={picture.pick}>
              Upload picture
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setFace(props.fallback)}>
              Use a face
            </Button>
          )}
        </div>
        <div className="flex flex-col gap-1.5 px-1">
          {(more ? botFaceFieldOrder : botFaceFieldOrder.slice(0, 2)).map((field) => (
            <PartRow
              key={field}
              field={field}
              face={shown}
              chosen={face !== undefined}
              wrap
              onChange={setFace}
            />
          ))}
        </div>
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((open) => !open)}
          className="flex w-fit items-center gap-1 rounded-md px-1.5 py-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground"
        >
          {more ? "Fewer parts" : finerWords}
          <CaretRightIcon
            aria-hidden
            size={12}
            className={cn(
              "shrink-0 transition-transform duration-(--motion-fast)",
              more && "rotate-90",
            )}
          />
        </button>
        {picture.input}
        {picture.said}
      </PopoverContent>
    </Popover>
  );
}

import {
  botFaceFields,
  botPairColours,
  changeFace,
  shuffleFace,
  stepFace,
  type BotFace as BotFaceModel,
  type BotFaceValue,
} from "@ace/ui-core/bot-face";
import { useState } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { Button } from "@/components/ui/button.tsx";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { cn } from "@/lib/cn.ts";
import { draftFace, LiveFace, usePictureUpload, type AvatarDraft } from "./spade-avatar-choice.tsx";
import { FaceAdvanced } from "./spade-face-advanced.tsx";
import { SpadeFace } from "./spade-face.tsx";

type PickerTab = "bot" | "generate" | "upload";
const tabs: readonly { id: PickerTab; name: string }[] = [
  { id: "bot", name: "Bot" },
  { id: "generate", name: "Generate" },
  { id: "upload", name: "Upload" },
];

const firstPairRow = botFaceFields.pair.slice(0, 6);
const secondPairRow = botFaceFields.pair.slice(6);

/**
 * The face picker's content: Bot (a grid of shapes in the face's colours, then two balanced rows
 * of colour swatches), Generate (live face, Shuffle, and Advanced rows), Upload (a picture), and
 * Reset to the face it had. Edits the same draft the face's popover saves on close.
 */
export function FacePicker(props: {
  value: AvatarDraft;
  fallback: BotFaceModel;
  takenPairs: readonly string[];
  onChange(value: AvatarDraft): void;
  /** Puts the draft back to the face the bot has. */
  onReset(): void;
}) {
  const [tab, setTab] = useState<PickerTab>("bot");
  const [advanced, setAdvanced] = useState(false);
  const picture = usePictureUpload(props.onChange);
  const { value } = props;
  const face = draftFace(value);
  const shown = face ?? props.fallback;
  const raw = value.kind === "face" ? value.raw : undefined;
  const setFace = (next: BotFaceModel) => props.onChange({ kind: "face", face: next, raw });

  const renderSwatch = (pair: (typeof botFaceFields.pair)[number]) => {
    const on = face !== undefined && shown.pair === pair;
    return (
      <button
        key={pair}
        type="button"
        role="radio"
        aria-checked={on}
        aria-label={`Colour: ${pair}`}
        tabIndex={on || (face === undefined && pair === botFaceFields.pair[0]) ? 0 : -1}
        onClick={() => setFace(changeFace(shown, "pair", pair as BotFaceValue<"pair">))}
        className={cn(
          "size-7 shrink-0 rounded-full shadow-[inset_0_0_0_1px_var(--border-strong)] outline-none transition-transform duration-(--motion-fast) hover:scale-110 focus-visible:shadow-[0_0_0_2px_var(--popover),0_0_0_4px_var(--focus)]",
          on && "shadow-[0_0_0_2px_var(--popover),0_0_0_3.5px_var(--foreground)]",
        )}
        style={{ backgroundColor: botPairColours[pair].dark.body }}
      />
    );
  };

  return (
    <div className="flex max-h-[min(36rem,80vh)] w-80 max-w-full flex-col overflow-x-hidden overflow-y-auto rounded-lg bg-popover">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2.5">
        <div
          role="tablist"
          aria-label="Face"
          className="inline-flex h-8 items-center rounded-full bg-(--seg-bg) p-0.5"
        >
          {tabs.map((each) => (
            <button
              key={each.id}
              type="button"
              role="tab"
              aria-selected={tab === each.id}
              onClick={() => setTab(each.id)}
              className={cn(
                "h-7 rounded-full px-2.5 text-xs transition-colors duration-(--motion-fast) focus-ring",
                tab === each.id
                  ? "bg-(--seg-thumb) font-medium text-foreground shadow-raised"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {each.name}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={props.onReset}
          className="ml-auto h-7 rounded-full px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground active:bg-active"
        >
          Reset
        </button>
      </div>

      {tab === "bot" && (
        <div className="flex flex-col gap-4 px-3.5 py-3.5">
          <div
            role="radiogroup"
            aria-label="Shape"
            onKeyDown={onRadioKeys}
            className="grid grid-cols-5 justify-items-center gap-1.5"
          >
            {botFaceFields.body.map((body) => {
              const option = changeFace(shown, "body", body as BotFaceValue<"body">);
              const on = face !== undefined && shown.body === body;
              return (
                <button
                  key={body}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`Body: ${body}`}
                  tabIndex={on || (face === undefined && body === botFaceFields.body[0]) ? 0 : -1}
                  onClick={() => setFace(option)}
                  className={cn(
                    "grid size-12 place-items-center rounded-full transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
                    on && "bg-active shadow-[inset_0_0_0_1px_var(--border-strong)]",
                  )}
                >
                  <BotFace face={option} size={36} />
                </button>
              );
            })}
          </div>
          <div
            role="radiogroup"
            aria-label="Colour"
            onKeyDown={onRadioKeys}
            className="flex flex-col items-center gap-2.5 border-t border-border-soft pt-3.5"
          >
            <div className="flex items-center justify-center gap-3">
              {firstPairRow.map(renderSwatch)}
            </div>
            <div className="flex items-center justify-center gap-3">
              {secondPairRow.map(renderSwatch)}
            </div>
          </div>
        </div>
      )}

      {tab === "generate" && (
        <>
          <div className="flex flex-col items-center gap-3 px-4 py-4">
            <div className="grid size-38 place-items-center rounded-xl bg-surface-1">
              <LiveFace face={shown} onStep={(field) => setFace(stepFace(shown, field))} />
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                variant="secondary"
                className="h-8 rounded-md px-3.5"
                onClick={() => setFace(shuffleFace(Math.random, shown, props.takenPairs))}
              >
                Shuffle
              </Button>
              <Button
                variant={advanced ? "secondary" : "ghost"}
                className="h-8 rounded-md px-3"
                aria-expanded={advanced}
                onClick={() => setAdvanced((open) => !open)}
              >
                Advanced
              </Button>
            </div>
            {!advanced && (
              <p className="text-center text-xs text-muted-foreground">
                Click any part of the face to change it.
              </p>
            )}
          </div>
          {advanced && <FaceAdvanced face={shown} chosen={face !== undefined} onChange={setFace} />}
        </>
      )}

      {tab === "upload" && (
        <div className="flex flex-col items-center gap-3 px-4 py-5">
          <div className="grid size-20 place-items-center overflow-hidden rounded-full bg-surface-1 ring-1 ring-border-soft">
            {value.kind === "image" ? (
              <img alt="" src={value.data} className="size-20 rounded-full object-cover" />
            ) : value.kind === "current" && !face ? (
              <SpadeFace avatar={value.avatar} size={72} />
            ) : (
              <BotFace face={shown} size={72} />
            )}
          </div>
          <Button variant="secondary" className="h-8 rounded-md px-3.5" onClick={picture.pick}>
            Upload picture
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            PNG, JPEG, GIF or WebP up to 3.75 MB.
          </p>
        </div>
      )}

      {picture.input}
      {picture.said && <div className="px-3.5 pb-3">{picture.said}</div>}
    </div>
  );
}

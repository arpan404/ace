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

/**
 * The face picker's content: Bot (a grid of shapes in the face's colours, then a row of colour
 * swatches), Generate (a new face each press), Upload (a picture), and Reset to the face it had.
 * It edits the same draft the face's popover saves on close.
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
  return (
    <div className="flex max-h-[min(36rem,80vh)] flex-col overflow-y-auto">
      <div
        role="tablist"
        aria-label="Face"
        className="flex items-center gap-0.5 border-b border-border-soft px-2 py-2"
      >
        {tabs.map((each) => (
          <button
            key={each.id}
            type="button"
            role="tab"
            aria-selected={tab === each.id}
            onClick={() => setTab(each.id)}
            className={cn(
              "h-7 rounded-full px-2.5 text-ui focus-ring",
              tab === each.id
                ? "bg-active font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {each.name}
          </button>
        ))}
        <button
          type="button"
          onClick={props.onReset}
          className="ml-auto h-7 rounded-full px-2.5 text-ui text-muted-foreground focus-ring hover:text-foreground"
        >
          Reset
        </button>
      </div>
      {tab === "bot" && (
        <div className="flex flex-col gap-4 p-3">
          <div role="radiogroup" aria-label="Shape" className="grid grid-cols-5 gap-1">
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
                  onClick={() => setFace(option)}
                  className={cn(
                    "grid size-12 place-items-center rounded-full focus-ring hover:bg-hover",
                    on && "bg-active",
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
            className="flex flex-wrap justify-center gap-2"
          >
            {botFaceFields.pair.map((pair) => {
              const on = face !== undefined && shown.pair === pair;
              return (
                <button
                  key={pair}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`Colour: ${pair}`}
                  onClick={() => setFace(changeFace(shown, "pair", pair as BotFaceValue<"pair">))}
                  className={cn(
                    "size-7 rounded-full focus-ring",
                    on && "shadow-[0_0_0_2px_var(--popover),0_0_0_3.5px_var(--foreground)]",
                  )}
                  style={{ backgroundColor: botPairColours[pair].dark.body }}
                />
              );
            })}
          </div>
        </div>
      )}
      {tab === "generate" && (
        <>
          <div className="flex flex-col items-center gap-3 p-4">
            <LiveFace face={shown} onStep={(field) => setFace(stepFace(shown, field))} />
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setFace(shuffleFace(Math.random, shown, props.takenPairs))}
              >
                Shuffle
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={advanced}
                onClick={() => setAdvanced((open) => !open)}
              >
                Advanced
              </Button>
            </div>
          </div>
          {advanced && <FaceAdvanced face={shown} chosen={face !== undefined} onChange={setFace} />}
        </>
      )}
      {tab === "upload" && (
        <div className="flex flex-col items-center gap-3 p-4">
          {value.kind === "image" ? (
            <img alt="" src={value.data} className="size-18 rounded-full object-cover" />
          ) : value.kind === "current" && !face ? (
            <SpadeFace avatar={value.avatar} size={72} />
          ) : (
            <BotFace face={shown} size={72} />
          )}
          <Button size="sm" variant="secondary" onClick={picture.pick}>
            Upload picture
          </Button>
        </div>
      )}
      {picture.input}
      <div className="px-3 pb-2">{picture.said}</div>
    </div>
  );
}

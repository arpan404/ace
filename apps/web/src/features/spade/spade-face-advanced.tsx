import {
  allowedFaceValues,
  botFaceFieldLabels,
  botFaceFieldOrder,
  botFaceFields,
  botPairColours,
  changeFace,
  type BotFace as BotFaceModel,
  type BotFaceField,
  type BotFaceValue,
} from "@ace/ui-core/bot-face";
import { ArrowsClockwiseIcon } from "@ace/icons";
import { BotFace } from "@/components/bot-face.tsx";
import { Icon } from "@/components/icon.tsx";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/** The options of one field that suit this face: its creature's and the ones that go together. */
function optionsOf(field: BotFaceField, face: BotFaceModel): readonly string[] {
  return field === "body" || field === "pair"
    ? botFaceFields[field]
    : allowedFaceValues(field, face);
}

/**
 * Advanced: one row per part of the face, in the editor's order, each a strip of small faces with
 * that option applied (Colours as pairs of swatches), the current one chosen. Options the creature
 * or the parts already worn rule out are left out. A dice shuffles just that part. Arrow keys move
 * along a row; Enter or Space picks.
 */
export function FaceAdvanced(props: {
  face: BotFaceModel;
  /** The face is the person's draft: only then is an option shown chosen. */
  chosen: boolean;
  onChange(face: BotFaceModel): void;
  /** Injected so the dice can be driven; `Math.random` in the app. */
  random?: () => number;
}) {
  const { face } = props;
  const random = props.random ?? Math.random;
  return (
    <div className="flex flex-col gap-3.5 border-t border-border-soft px-3.5 py-3.5">
      {botFaceFieldOrder.map((field) => {
        const options = optionsOf(field, face);
        if (options.length < 2) return null;
        const label = botFaceFieldLabels[field];
        return (
          <div key={field} className="flex min-w-0 flex-col gap-1.5">
            <div className="flex items-center">
              <span className="text-xs font-medium text-muted-foreground">{label}</span>
              <Tip label={`Shuffle ${label.toLowerCase()}`}>
                <button
                  type="button"
                  aria-label={`Shuffle ${label.toLowerCase()}`}
                  onClick={() => {
                    const at = Math.min(options.length - 1, Math.floor(random() * options.length));
                    props.onChange(
                      changeFace(face, field, options[at] as BotFaceValue<typeof field>),
                    );
                  }}
                  className="ml-auto grid size-6 place-items-center rounded-full text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground"
                >
                  <Icon icon={ArrowsClockwiseIcon} size={13} />
                </button>
              </Tip>
            </div>
            <div
              role="radiogroup"
              aria-label={label}
              onKeyDown={onRadioKeys}
              className="grid grid-cols-6 justify-items-center gap-1.5 py-0.5"
            >
              {options.map((value) => {
                const option = changeFace(face, field, value as BotFaceValue<typeof field>);
                const on = props.chosen && face[field] === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`${label}: ${value}`}
                    tabIndex={on || (!props.chosen && value === options[0]) ? 0 : -1}
                    onClick={() => props.onChange(option)}
                    className={cn(
                      "grid size-10 shrink-0 place-items-center rounded-full transition-colors duration-(--motion-fast) focus-ring hover:bg-hover",
                      on && "bg-active shadow-[0_0_0_1.5px_var(--foreground)]",
                    )}
                  >
                    {field === "pair" ? (
                      <PairSwatch pair={value as keyof typeof botPairColours} />
                    ) : (
                      <BotFace face={option} size={30} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A colour pair: its body colour, with its accent as the smaller dot. */
function PairSwatch(props: { pair: keyof typeof botPairColours }) {
  const colours = botPairColours[props.pair].dark;
  return (
    <span
      aria-hidden
      className="relative size-6 rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)]"
      style={{ backgroundColor: colours.body }}
    >
      <span
        className="absolute right-0 bottom-0 size-2.5 rounded-full"
        style={{ backgroundColor: colours.accent }}
      />
    </span>
  );
}

import {
  spadeAccentChoicesOn,
  spadeAccentHolds,
  spadeStandardCanvases,
} from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { SettingRow } from "@/components/setting-row.tsx";
import { onRadioKeys } from "@/components/ui/radio-keys.ts";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useCanvasColours } from "@/theme/theme-provider.tsx";
import { useEditBot } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";
import type { RosterBot } from "./use-spade-roster.ts";

const swatch =
  "relative size-6 shrink-0 rounded-full outline-none shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] aria-checked:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--ring)] focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus)]";

/**
 * The bot's accent (ADR 0200 §5.3), a row of Personality: its face's colour, then the colours
 * that hold 3:1 on every surface of the theme or Suit on screen, in both schemes. Its package's
 * accent shows as chosen until the person picks; their pick is kept through updates.
 */
export function AccentRow(props: { bot: RosterBot }) {
  const { bot } = props;
  const edit = useEditBot(bot);
  const canvases = useCanvasColours() ?? spadeStandardCanvases;
  const choices = spadeAccentChoicesOn(canvases);
  const [shown, setShown] = useState<string | null>();
  const [refusal, setRefusal] = useState<string>();
  const stored = shown !== undefined ? shown : (bot.style?.accent ?? null);
  const all = [...canvases.light, ...canvases.dark];
  // A colour that doesn't hold here shows as its face's colour, as it is drawn.
  const current = stored && spadeAccentHolds(stored, all) ? stored : null;
  // A package's own colour, not one of the choices, is offered while it holds.
  const offered =
    current && !choices.some((choice) => choice.hex === current)
      ? [...choices, { name: "Its package's colour", hex: current }]
      : choices;
  const save = async (accent: string | null) => {
    if (accent === stored) return;
    setShown(accent);
    setRefusal(undefined);
    setRefusal(await edit({ style: { accent } }));
    setShown(undefined);
  };
  const options = [{ name: "Its face's colour", hex: null }, ...offered];
  return (
    <SettingRow
      title="Accent"
      description={
        refusal ? (
          <Refusal>{refusal}</Refusal>
        ) : choices.length === 0 ? (
          "No colour holds on this Suit, so it uses its face's colour."
        ) : (
          "Marks its face, its row in lists and its cards."
        )
      }
      density="compact"
    >
      <div
        role="radiogroup"
        aria-label="Accent"
        onKeyDown={onRadioKeys}
        className="flex flex-wrap items-center gap-2 px-1 py-1"
      >
        {options.map((option) => {
          const checked = option.hex === current;
          return (
            <Tip key={option.hex ?? "face"} label={option.name}>
              <button
                type="button"
                role="radio"
                aria-label={option.name}
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                onClick={() => void save(option.hex)}
                className={cn(swatch, option.hex === null && "bg-fill-strong")}
                style={option.hex ? { backgroundColor: option.hex } : undefined}
              >
                {option.hex === null && (
                  <span aria-hidden className="absolute inset-1.5 rounded-full bg-background" />
                )}
              </button>
            </Tip>
          );
        })}
      </div>
    </SettingRow>
  );
}

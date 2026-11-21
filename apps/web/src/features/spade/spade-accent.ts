import {
  spadeAgentAccent,
  spadeBotMarkAccent,
  spadeStandardCanvases,
  type SpadeAgentStyle,
  type SpadeAvatar,
} from "@ace/ui-core/spade-chat";
import type { CSSProperties } from "react";
import { useCanvasColours } from "@/theme/theme-provider.tsx";

/*
 * A bot's accent as CSS (ADR 0200 §5.3, docs/design/spade.md): `--agent-accent-light` and
 * `--agent-accent-dark`, each checked against the live theme or Suit's surfaces in that scheme.
 * The card's title rule always has one (the face's pair colour without a style); the face ring
 * and the list row's marker only for a bot with a `style.accent`.
 */

export interface BotAccentInput {
  avatar: SpadeAvatar;
  style?: SpadeAgentStyle | undefined;
}

type AccentVariables = CSSProperties & {
  "--agent-accent-light"?: string;
  "--agent-accent-dark"?: string;
};

/** The card's title rule: the bot's accent, or its face's colour, or the border for none. */
export function useCardAccent(bot: BotAccentInput): AccentVariables {
  const canvases = useCanvasColours() ?? spadeStandardCanvases;
  return {
    "--agent-accent-light":
      spadeAgentAccent(bot.avatar, "light", bot.style, canvases.light) ?? "var(--border)",
    "--agent-accent-dark":
      spadeAgentAccent(bot.avatar, "dark", bot.style, canvases.dark) ?? "var(--border)",
  };
}

/** The face ring and list marker: undefined for a bot with no `style.accent`. */
export function useMarkAccent(bot: BotAccentInput): AccentVariables | undefined {
  const canvases = useCanvasColours() ?? spadeStandardCanvases;
  const light = spadeBotMarkAccent(bot.avatar, "light", bot.style, canvases.light);
  const dark = spadeBotMarkAccent(bot.avatar, "dark", bot.style, canvases.dark);
  if (!light || !dark) return undefined;
  return { "--agent-accent-light": light, "--agent-accent-dark": dark };
}

/** The accent's colour in the scheme on screen, as a Tailwind arbitrary value. */
export const accentFill = "bg-(--agent-accent-light) dark:bg-(--agent-accent-dark)";

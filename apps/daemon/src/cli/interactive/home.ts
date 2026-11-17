import { overview } from "../help/pages.ts";
import { emit } from "../io.ts";
import type { CommandContext } from "../run/context.ts";

/** The interactive home (ADR 0176 §9). Until its views land, a terminal gets the overview. */
export async function interactiveHome(context: CommandContext): Promise<void> {
  await emit(context.args, overview(context.table));
}

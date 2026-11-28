import type { SlashAction } from "./use-spade-slash.ts";

/**
 * What `/` does in a bot's conversation besides starting a skill or command: each goes where the
 * screen already goes (Stop, Settings' models, the profile's tabs). `stop` is undefined while
 * nothing is running, and the row is left out then.
 */
export function slashActions(run: {
  stop: (() => void) | undefined;
  model(): void;
  routines(): void;
  library(): void;
  computer(): void;
}): readonly SlashAction[] {
  const all: (SlashAction | undefined)[] = [
    run.stop && {
      id: "stop",
      name: "stop",
      description: "Stop the reply in progress",
      run: run.stop,
    },
    { id: "model", name: "model", description: "Open Model settings", run: run.model },
    {
      id: "routine",
      name: "routine",
      description: "Open its routines, under Activity",
      run: run.routines,
    },
    { id: "library", name: "library", description: "Open the Library tab", run: run.library },
    { id: "computer", name: "computer", description: "Open its computer", run: run.computer },
  ];
  return all.filter((action) => action !== undefined);
}

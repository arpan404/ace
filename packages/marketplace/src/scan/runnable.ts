import type { ScanInput } from "./index.ts";
import { recipeEntries } from "../recipe.ts";
import { instructionScripts } from "./instructions.ts";
import { fileScriptView } from "./script-view.ts";
import { scanText } from "./decode.ts";
import { safeBinary } from "./binary.ts";
import { panelPages } from "./checks-panel.ts";

/*
 * Whether a version carries runnable content (ADR 0174 §8). Static analysis is never complete, so
 * the scanner is a filter in front of runtime containment, not the boundary: any version with a
 * scene or panel, a script, a hook, a server command, a binary, or instructions that run commands is held
 * for a maintainer, whatever the publisher. Only a pure data entry (a Suit with no scene, a recipe
 * or skill with nothing runnable) lists on scan pass alone. Pure.
 */

export interface Runnable {
  runnable: boolean;
  reason?: string;
}

const yes = (reason: string): Runnable => ({ runnable: true, reason });
const no: Runnable = { runnable: false };

/** An entry's runnable content, and why. */
export function runnableContent(input: ScanInput): Runnable {
  // A bot package's own code (ADR 0203 §5): held for a maintainer, whoever publishes it.
  if (input.inspection?.type === "spade-bot" && (input.inspection.recipe.code?.length ?? 0) > 0)
    return yes("it runs its own code (WebAssembly components)");
  // Any executable bit, or a binary that isn't recognised safe data, makes a version runnable:
  // the scanner never infers safety from unrecognised bytes.
  for (const file of input.files) {
    if (file.executable) return yes(`${file.path} is executable`);
    const decoded = scanText(file.content);
    if (decoded === undefined && !safeBinary(file.content, file.path))
      return yes(`${file.path} is a binary ace can't read`);
  }

  switch (input.inspection?.type) {
    case "suit":
      return input.inspection.scenes.length > 0
        ? yes("it runs its own animation (a scene)")
        : (runnableFromInstructions(input) ?? no);
    case "spade-plugin":
      if (input.inspection.executions.length > 0)
        return yes("it runs hooks or a server command once accepted");
      return runnableFromScripts(input) ?? runnableFromInstructions(input) ?? no;
    case "spade-skill":
      // An executable or unknown binary is already caught above; a plain data file (an image)
      // isn't runnable. Here we only look for a script's own text and the instructions.
      return runnableFromScripts(input) ?? runnableFromInstructions(input) ?? no;
    case "spade-bot": {
      // A panel is a page that runs in its frame: reviewed per version, as a scene is.
      if (panelPages(input.files).length > 0) return yes("it runs its own page (a panel)");
      if (recipeEntries(input.inspection.recipe).length > 0)
        return yes("it brings skills or plugins that run");
      return runnableFromScripts(input) ?? runnableFromInstructions(input) ?? no;
    }
    default:
      // A type whose checks didn't pass, or `ace-plugin`: treat as runnable, held for review.
      return yes("it needs a maintainer's review");
  }
}

/** Runnable because a file is a script the scanner reads (a plugin without declared executions). */
function runnableFromScripts(input: ScanInput): Runnable | undefined {
  for (const file of input.files) {
    const source = scanText(file.content)?.text;
    if (source !== undefined && fileScriptView(input.type, file.path, source) !== undefined)
      return yes(`${file.path} is a script`);
  }
  return undefined;
}

/** Runnable because its instructions give an agent a command to run. */
function runnableFromInstructions(input: ScanInput): Runnable | undefined {
  const scripts = instructionScripts(input, () => false);
  const hasCommand = scripts.some((script) => script.text.trim().length > 0);
  return hasCommand ? yes("its instructions tell the agent to run commands") : undefined;
}

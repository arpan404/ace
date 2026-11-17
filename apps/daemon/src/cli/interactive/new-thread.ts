import { basename, resolve } from "node:path";
import { ProviderKind, type Project } from "@ace/protocol";
import { providerDisplayName } from "@ace/ui-core";
import { CliFailure } from "../output.ts";
import type { Terminal } from "../tui/terminal.ts";

/**
 * New thread (`n`, ADR 0176 §9): the project (this folder first, then the known ones), then
 * the provider and model with the person's defaults first. The prompt is typed in attach's
 * composer next, so Enter sends, Alt+Enter adds a line and Ctrl-G opens $EDITOR. Each question
 * names the flag that would have answered it.
 */
export interface NewThread {
  /** A project id, or a folder path the daemon adds as a project. */
  readonly project: string;
  readonly provider: ProviderKind;
  readonly model: string | undefined;
}

/** The projects offered, this folder first: pure, for the picker. */
export function projectChoices(
  cwd: string,
  projects: readonly Project[],
): { value: string; label: string; hint?: string }[] {
  const here = resolve(cwd);
  const known = projects.find((project) => resolve(project.path) === here);
  const first = known
    ? { value: known.id, label: known.name, hint: "this folder" }
    : { value: here, label: basename(here) || here, hint: "this folder, added as a project" };
  return [
    first,
    ...projects
      .filter((project) => project.id !== known?.id)
      .map((project) => ({ value: project.id, label: project.name, hint: project.path })),
  ];
}

/** The providers offered, the person's default first: pure. */
export function providerChoices(
  preferred: ProviderKind | undefined,
): { value: ProviderKind; label: string }[] {
  const all = ProviderKind.options.map((value) => ({ value, label: providerDisplayName(value) }));
  const index = all.findIndex((choice) => choice.value === preferred);
  if (index <= 0) return all;
  const [chosen] = all.splice(index, 1);
  return chosen ? [{ ...chosen, label: `${chosen.label} (your default)` }, ...all] : all;
}

/** Asks for the new thread's project, provider and model; undefined when the person cancels. */
export async function askNewThread(
  terminal: Terminal,
  input: {
    cwd: string;
    projects: readonly Project[];
    defaultProvider: ProviderKind | undefined;
  },
): Promise<NewThread | undefined> {
  terminal.suspend();
  try {
    const { askSelect, askText } = await import("../ask.ts");
    const projects = projectChoices(input.cwd, input.projects);
    const project = await askSelect("Project (--project)", projects);
    const defaults = input.projects.find((candidate) => candidate.id === project)?.defaults;
    const provider = await askSelect(
      "Agent (--provider)",
      providerChoices(defaults?.provider ?? input.defaultProvider),
    );
    const projectModel = defaults?.provider === provider ? defaults.model : undefined;
    const modelChoice = await askSelect("Model (--model)", [
      { value: "default", label: projectModel ?? "The provider's default", hint: "your default" },
      { value: "other", label: "Another model" },
    ]);
    const model =
      modelChoice === "other"
        ? await askText("Model (--model)", "The provider's model id")
        : projectModel;
    return { project, provider, model };
  } catch (error) {
    if (error instanceof CliFailure) return undefined;
    throw error;
  } finally {
    terminal.resume();
  }
}

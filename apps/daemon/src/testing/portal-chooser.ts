/*
 * The person at the screen-sharing chooser, for end-to-end tests on Hyprland. The e2e runner points the portal's chooser at portal-picker.sh, which
 * answers from the file named by ACE_E2E_PICKER_CHOICE; GNOME sessions have no such file and
 * use seed_portal.py instead. Test scaffolding only: ace never configures a chooser.
 */
import { readFile, rm, writeFile } from "node:fs/promises";

const choiceFile = process.env.ACE_E2E_PICKER_CHOICE;

/** Whether this desktop's chooser is answered through portal-picker.sh. */
export const scriptedChooser = !!choiceFile;

/** The person's next answer: share an app's window (by its Wayland app id), a monitor, or decline. */
export type ChooserAnswer = { window: string } | "screen" | "cancel";

export async function answerChooser(answer: ChooserAnswer): Promise<void> {
  if (!choiceFile) throw new Error("This desktop's chooser is not scripted");
  const line = typeof answer === "string" ? answer : `window ${answer.window}`;
  await writeFile(choiceFile, `${line}\n`);
}

/** Nobody is at the chooser: the next one stays unanswered until a person would give up. */
export async function leaveChooserUnanswered(): Promise<void> {
  if (choiceFile) await rm(choiceFile, { force: true });
}

/** How many times the chooser has been shown to the person so far. */
export async function chooserShown(): Promise<number> {
  if (!choiceFile) return 0;
  const log = await readFile(`${choiceFile}.log`, "utf8").catch(() => "");
  return log.split("\n").filter((line) => line.startsWith("asked ")).length;
}

import { showsAt } from "./spade-story.ts";

/*
 * Which parts of the /spade/ walkthrough's drawn messenger are open at a step. A wide window
 * shows the list and the conversation, and the profile in its own column when a feature needs
 * it. A phone-sized window shows one of them at a time, full width, as the iPhone app does:
 * the list where its rows tell the feature, the profile sheet where the profile does, else the
 * conversation.
 */

export type View = "list" | "chat" | "panel";

/** The steps the profile is open in. */
export const panelSpan = "0,3-6,9";

/** On a phone, the steps the list tells (clubs, routines, always yours). */
const listSpan = "1,5,11";

/** On a phone, the steps the profile tells (the bot's details, computer, memory, model). */
const phonePanelSpan = "0,3-4,9";

/** Whether the profile is open beside the conversation at `step`. */
export const panelOpenAt = (step: number): boolean => showsAt(panelSpan, step);

/** The one part a phone-sized window shows at `step`. */
export function phoneViewAt(step: number): View {
  if (showsAt(listSpan, step)) return "list";
  if (showsAt(phonePanelSpan, step)) return "panel";
  return "chat";
}

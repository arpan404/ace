/*
 * First run (the main Spade's chat, once Spade is on and has a model): a short "About you"
 * interview whose answers become the shared About-you notes every bot sees, then starter bots
 * from the templates. Every question may be left empty and the whole of it skipped; the notes are
 * the person's own, edited later in Library › About you. Pure.
 */

export type SpadeAboutYouField = "name" | "work" | "help" | "voice";

export interface SpadeAboutYouQuestion {
  field: SpadeAboutYouField;
  /** What Spade asks, as its words in the card. */
  ask: string;
  placeholder: string;
  /** Quick answers the person can pick instead of typing. */
  picks: readonly string[];
}

export const spadeAboutYouQuestions: readonly SpadeAboutYouQuestion[] = [
  { field: "name", ask: "What should I call you?", placeholder: "Your name", picks: [] },
  {
    field: "work",
    ask: "What do you do?",
    placeholder: "Your work, your studies, what fills your days",
    picks: [],
  },
  {
    field: "help",
    ask: "What would you like help with?",
    placeholder: "Email, research, trips, code, money…",
    picks: [],
  },
  {
    field: "voice",
    ask: "How do you like to be talked to?",
    placeholder: "Or say it your way",
    picks: ["Short and to the point", "Friendly and warm", "Formal", "Detailed, with the why"],
  },
];

/** Each note's words, by what it answers. */
const said: Record<SpadeAboutYouField, (answer: string) => string> = {
  name: (answer) => `The person's name is ${answer}.`,
  work: (answer) => `What they do: ${answer}`,
  help: (answer) => `What they want help with: ${answer}`,
  voice: (answer) => `How they like to be talked to: ${answer}`,
};

/** The longest a note may be (Spade's own bound). */
const longest = 500;

/** The About-you notes the answers make, one per answer given, in the questions' order. */
export function spadeAboutYouNotes(answers: Partial<Record<SpadeAboutYouField, string>>): string[] {
  return spadeAboutYouQuestions.flatMap(({ field }) => {
    const answer = answers[field]?.replace(/\s+/g, " ").trim();
    if (!answer) return [];
    return [said[field](answer).slice(0, longest)];
  });
}

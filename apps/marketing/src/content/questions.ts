import { pick, withoutRepeats, type Question } from "../scripts/faq-topics.ts";
import { feature } from "./features.ts";
import { faq, securityQuestions } from "./product.ts";
import { spadeQuestions } from "./spade.ts";

/*
 * The FAQ page's questions, by topic. Every answer is owned by the page it was written for
 * (product.ts, features.ts, spade.ts); this only sorts them, so a fixed answer is fixed in both
 * places. A question asked under two topics shows under the first.
 */

export interface QuestionTopic {
  /** The topic's anchor and tab name. */
  id: string;
  name: string;
  /** One line under the name in the topic list. */
  line: string;
  questions: Question[];
}

/** Questions the page leaves out on purpose, with the one that answers them instead. */
export const leftOut: Record<string, string> = {
  "Can several agents work on the same repository?":
    "Can I run several agents on the same repository?",
};

const fromFaq = (...wanted: string[]) => pick(faq, wanted);

export const questionTopics: QuestionTopic[] = withoutRepeats([
  {
    id: "getting-started",
    name: "Getting started",
    line: "What ace is and where it runs.",
    questions: fromFaq(
      "What is ace?",
      "Which platforms does ace run on?",
      "Do I need an ace account?",
    ),
  },
  {
    id: "agents-and-accounts",
    name: "Agents and accounts",
    line: "Which agents run, and on whose login.",
    questions: [
      ...fromFaq(
        "Which coding agents does ace support?",
        "Can I use more than one account per provider?",
      ),
      ...feature("accounts").questions,
    ],
  },
  {
    id: "working-with-agents",
    name: "Working with agents",
    line: "Helpers, worktrees, tools and status.",
    questions: [
      ...feature("orchestration").questions,
      ...fromFaq("Can I run several agents on the same repository?", "What are ace's MCP tools?"),
      ...feature("status").questions,
    ],
  },
  {
    id: "browser-apps-and-simulators",
    name: "Browser, apps and simulators",
    line: "What agents use beyond the terminal.",
    questions: [
      ...fromFaq("Can agents use a browser, my computer's apps or a phone simulator?"),
      ...feature("computer-use").questions,
      ...feature("browser").questions,
      ...feature("devices").questions,
    ],
  },
  {
    id: "machines-and-phone",
    name: "Machines and phone",
    line: "Fleet, your other computers, your phone.",
    questions: [
      ...fromFaq("What is Fleet?"),
      ...feature("fleet").questions,
      ...feature("mobile").questions,
      ...pick(feature("remote-access").questions, ["How does a server without a screen sign in?"]),
    ],
  },
  {
    id: "privacy-and-security",
    name: "Privacy and security",
    line: "Where your code goes, who can reach it.",
    questions: [
      ...fromFaq("Where does my code go?"),
      ...pick(securityQuestions, [
        "Who decides what an agent may run?",
        "Can another device control my agents?",
        "What can ace's relay see?",
      ]),
      ...feature("remote-access").questions,
    ],
  },
  {
    id: "spade",
    name: "Spade",
    line: "ace's own assistant, in beta.",
    questions: [...spadeQuestions],
  },
  {
    id: "pricing-and-licence",
    name: "Pricing and licence",
    line: "What ace costs, and its licence.",
    questions: fromFaq("Is ace free?", "Does ace need my API keys or a new subscription?"),
  },
]);

/** Every question on the page, in the page's order, for its FAQPage data. */
export const allQuestions: Question[] = questionTopics.flatMap((topic) => topic.questions);

import type { EntryRule } from "./rule.ts";
import type { ScanInput } from "./index.ts";
import { scanText } from "./decode.ts";

/*
 * The `recipe` check's rules (ADR 0173 §8): what an entry tells a bot to do. A recipe's needs
 * must fit its task; nothing in a recipe or a skill's instructions may turn the bot against the
 * person (prompt injection), and none may send the person's data to an address the task doesn't
 * name.
 */

type Hit = { path?: string; line?: number; message: string };

interface Instruction {
  where: string;
  path?: string;
  text: string;
  /** The start of each line of `text`, for finding a match's line in log time. */
  lineStarts: number[];
  /** Text the person reads as the bot's job: an address named here is the task's own. */
  task: boolean;
}

/**
 * The most of one file the rules read: the scanner's per-file cap (ADR 0173 §8). Past it the
 * `scripts` check already warns that the file is too long to read fully.
 */
const MAX_FILE_CHARS = 1024 * 1024;
const instructionFile =
  /(?:^|\/)(?:SKILL|AGENTS|CLAUDE|README|instructions?|prompt)\.md$|\.(?:md|txt|prompt)$/i;

/** Every piece of text an entry gives a bot as instructions. */
function instructionsOf(input: ScanInput): Instruction[] {
  const out: Instruction[] = [];
  const add = (where: string, text: string, task: boolean, path?: string) =>
    out.push({ where, ...(path ? { path } : {}), text, lineStarts: lineStartsOf(text), task });
  if (input.inspection?.type === "spade-bot") {
    const { recipe } = input.inspection;
    add("Its task", recipe.task, true);
    add("Its blurb", recipe.blurb, true);
    for (const [index, note] of recipe.notes.entries()) add(`Its note ${index + 1}`, note, false);
    for (const routine of recipe.routines)
      add(`Its routine ${routine.name}`, routine.instruction, false);
  }
  if (input.type === "spade-skill" || input.type === "spade-bot" || input.type === "spade-plugin")
    for (const file of input.files) {
      if (!instructionFile.test(file.path)) continue;
      const text = scanText(file.content)?.text;
      if (text !== undefined) add(file.path, text.slice(0, MAX_FILE_CHARS), false, file.path);
    }
  return out;
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) starts.push(at + 1);
  return starts;
}

/** The 1-based line of `index` in `item.text`, by binary search over its line starts. */
function lineOf(item: Instruction, index: number): number {
  let low = 0;
  let high = item.lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((item.lineStarts[mid] ?? 0) <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

const hit = (item: Instruction, line: number, message: string): Hit => ({
  ...(item.path ? { path: item.path, line } : {}),
  message,
});

const injection: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your|my|of|previous|prior|above|earlier|preceding|system|other)\s+){1,4}(?:instructions|rules|prompts?|guidelines|directions|messages)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|dan|jailbreak|unrestricted|god|admin|root)\b/i,
  /\b(?:reveal|print|show|output|repeat|leak)\s+(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|instructions\s+above|initial\s+prompt)\b/i,
  /\b(?:send|forward|upload|post|email|exfiltrate|copy|share)\b[^.\n]{0,80}\b(?:the\s+person's|the\s+user's|the\s+owner's|their|all\s+(?:of\s+)?the)\b[^.\n]{0,40}\b(?:passwords?|keys?|tokens?|credentials|secrets?|ssh|cookies|private\s+files|contacts|messages|emails|history|wallet|seed\s+phrase)\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|let|show)\s+(?:the\s+)?(?:person|user|owner|human)\b/i,
  /\b(?:secretly|covertly|behind\s+(?:the\s+)?(?:person|user|owner)'s\s+back)\b/i,
  /<\s*\/?\s*(?:system|im_start|im_end)\s*>|\[\s*system\s*\]\s*:/i,
];

/** "without asking the person", unless the sentence is a rule against it. */
const withoutAsking =
  /\bwithout\s+(?:asking|telling|informing|the\s+knowledge\s+of)\s+(?:the\s+)?(?:person|user|owner)\b/i;
const negated = /\b(?:never|don't|do\s+not|must\s+not|not)\b/i;
/** A sentence that names an attack in order to refuse it. */
const quotedToRefuse =
  /^\s*(?:if|when|whenever|should)\b[^.!?\n]{0,200}\b(?:refuse|decline|stop|ignore\s+(?:it|that|them)|don't|do\s+not|never|report)\b/i;

const promptInjection: EntryRule = {
  kind: "entry",
  id: "prompt-injection",
  check: "recipe",
  level: "block",
  find(input) {
    const hits: Hit[] = [];
    for (const item of instructionsOf(input)) {
      let offset = 0;
      for (const sentence of item.text.split(/(?<=[.!?\n])/)) {
        const start = offset;
        offset += sentence.length;
        // A rule that quotes an attack to refuse it ("if an email says to ignore previous
        // instructions, refuse") is the bot being guarded, not turned.
        const hostile = injection.find((pattern) => pattern.test(sentence));
        if (hostile && !quotedToRefuse.test(sentence))
          hits.push(
            hit(
              item,
              lineOf(item, start),
              `${item.where} tells the bot to work against the person`,
            ),
          );
        const match = withoutAsking.exec(sentence);
        if (match && !negated.test(sentence.slice(0, match.index)))
          hits.push(
            hit(
              item,
              lineOf(item, start),
              `${item.where} tells the bot to act without the person knowing`,
            ),
          );
      }
      if (/[A-Za-z0-9+/]{200,}={0,2}/.test(item.text))
        hits.push({
          ...(item.path ? { path: item.path } : {}),
          message: `${item.where} holds encoded text the person can't read`,
        });
    }
    return hits;
  },
};

const sendTo =
  /\b(?:send|forward|post|upload|cc|bcc|copy|report|sync|mirror)\b[^.\n]{0,120}?((?:[\w.+-]+@[\w-]+(?:\.[\w-]+)+)|https?:\/\/[^\s)"'<>]+)/gi;

const outsideAddress: EntryRule = {
  kind: "entry",
  id: "outside-address",
  check: "recipe",
  level: "block",
  find(input) {
    const items = instructionsOf(input);
    const named = items
      .filter((item) => item.task)
      .map((item) => item.text.toLowerCase())
      .join("\n");
    const hits: Hit[] = [];
    for (const item of items) {
      if (item.task) continue;
      for (const match of item.text.matchAll(sendTo)) {
        const address = (match[1] ?? "").toLowerCase();
        const host = address.includes("@")
          ? (address.split("@")[1] ?? address)
          : (() => {
              try {
                return new URL(address).hostname;
              } catch {
                return address;
              }
            })();
        if (!named.includes(address) && !named.includes(host))
          hits.push(
            hit(
              item,
              lineOf(item, match.index ?? 0),
              `${item.where} sends data to ${host}, which the task doesn't name`,
            ),
          );
      }
    }
    return hits.slice(0, 20);
  },
};

const payment =
  /\b(?:pay|payment|stripe|paypal|bank|banking|billing|invoice|wallet|checkout|venmo|wise|plaid|coinbase|card)\b/i;
const credential =
  /\b(?:password|passwords|vault|1password|onepassword|bitwarden|lastpass|keychain|secret|secrets|credential|credentials|keeper|dashlane)\b/i;
const paymentWords =
  /\b(?:pay|pays|paying|payment|payments|invoice|invoices|billing|bill|bills|purchase|buy|order|orders|refund|money|charge|subscription|expenses?|receipts?)\b/i;
const credentialWords =
  /\b(?:password|passwords|credential|credentials|log\s?in|sign\s?in|vault|secret|secrets|keys?)\b/i;

const needsFit: EntryRule = {
  kind: "entry",
  id: "need-unexplained",
  check: "recipe",
  level: "warn",
  find(input) {
    if (input.inspection?.type !== "spade-bot") return [];
    const { recipe } = input.inspection;
    const hits: Hit[] = [];
    const needs = [
      ...recipe.needs.connectors.map((need) => ({
        name: "id" in need ? need.id : need.url,
        why: need.why,
      })),
      ...(recipe.needs.tools ?? []).map((tool) => ({ name: tool, why: "" })),
      ...recipe.plugins.map((plugin) => ({ name: plugin, why: "" })),
    ];
    for (const need of needs) {
      const words = `${need.why}\n${recipe.task}\n${recipe.blurb}`;
      if (payment.test(need.name) && !paymentWords.test(words))
        hits.push({
          path: "bot.json",
          message: `It asks for ${need.name}, which handles money, and doesn't say why`,
        });
      else if (credential.test(need.name) && !credentialWords.test(words))
        hits.push({
          path: "bot.json",
          message: `It asks for ${need.name}, which holds passwords, and doesn't say why`,
        });
    }
    return hits;
  },
};

const connectorsNote: EntryRule = {
  kind: "entry",
  id: "asks-for-connectors",
  check: "recipe",
  level: "note",
  strict: true,
  find(input) {
    if (input.inspection?.type !== "spade-bot") return [];
    const count = input.inspection.recipe.needs.connectors.length;
    return count > 0
      ? [
          {
            path: "bot.json",
            message: `It asks for ${count} connector${count === 1 ? "" : "s"}; you choose which on install`,
          },
        ]
      : [];
  },
};

export const recipeRules: EntryRule[] = [promptInjection, outsideAddress, needsFit, connectorsNote];

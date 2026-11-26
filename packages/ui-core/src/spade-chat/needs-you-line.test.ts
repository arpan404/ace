import { expect, test } from "vitest";
import { spadeNeedsYouLine, type SpadePendingAsk } from "./needs-you-line.ts";

const approval = (
  name: string,
  args: unknown,
  effect?: string,
): Extract<SpadePendingAsk, { kind: "approval" }> => ({
  kind: "approval",
  name,
  arguments: args,
  effect,
});

test("an email approval says who it would write to", () => {
  expect(
    spadeNeedsYouLine([
      approval("send_email", { to: "Marta Reyes", subject: "Hello" }, "send_as_person"),
    ]),
  ).toBe("Wants to email Marta Reyes");
});

test("a payment approval says the amount and the payee", () => {
  expect(
    spadeNeedsYouLine([
      approval("checkout", { amount: 412, currency: "EUR", payee: "TAP Air Portugal" }, "pay"),
    ]),
  ).toBe("Wants to pay €412.00 to TAP Air Portugal");
});

test("a shell approval names the command by its words, not its arguments", () => {
  expect(
    spadeNeedsYouLine([approval("shell", { command: "gh pr comment 2107 --body-file note.md" })]),
  ).toBe("Wants to run gh pr comment");
});

test("a question is quoted and shortened with an ellipsis", () => {
  expect(spadeNeedsYouLine([{ kind: "question", prompt: "Q2 or Q3 last year?" }])).toBe(
    "Asks: Q2 or Q3 last year?",
  );
  const long = spadeNeedsYouLine([{ kind: "question", prompt: "word ".repeat(40) }]);
  expect(long.endsWith("…")).toBe(true);
  expect(long.length).toBeLessThan(70);
});

test("a connect card says which app to connect", () => {
  expect(spadeNeedsYouLine([{ kind: "connect", app: "GitHub" }])).toBe(
    "Wants you to connect GitHub",
  );
});

test("with several waiting it leads with the most important and counts the rest", () => {
  const question: SpadePendingAsk = { kind: "question", prompt: "Which hotel?" };
  const connect: SpadePendingAsk = { kind: "connect", app: "Notion" };
  const shell = approval("shell", { command: "ls -la" });
  const access = approval("grant", {}, "change_access");
  const send = approval("send_email", { to: "Ana" }, "send_as_person");
  const pay = approval("checkout", { amount: 5, currency: "EUR", payee: "Cafe" }, "pay");
  expect(spadeNeedsYouLine([question, shell, pay])).toBe("Wants to pay €5.00 to Cafe · +2 more");
  expect(spadeNeedsYouLine([question, shell, send])).toBe("Wants to email Ana · +2 more");
  expect(spadeNeedsYouLine([question, shell, access])).toMatch(/^Wants to .* · \+2 more$/);
  expect(spadeNeedsYouLine([question, connect, shell])).toBe(
    "Wants you to connect Notion · +2 more",
  );
  expect(spadeNeedsYouLine([question, shell])).toBe("Wants to run ls · +1 more");
});

test("with nothing pending it falls back to the bot's own words, else Needs you", () => {
  expect(spadeNeedsYouLine([], "Asks about the hotel")).toBe("Asks about the hotel");
  expect(spadeNeedsYouLine([], "Waiting for you")).toBe("Needs you");
  expect(spadeNeedsYouLine([])).toBe("Needs you");
});

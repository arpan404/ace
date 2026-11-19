import { expect, test } from "vitest";
import { features } from "./features.ts";
import { faq, securityQuestions } from "./product.ts";
import { allQuestions, leftOut, questionTopics } from "./questions.ts";
import { spadeQuestions } from "./spade.ts";

const onPage = new Set(allQuestions.map((entry) => entry.question));

test("every question another page answers is on the FAQ page, unless left out for a twin", () => {
  const sources = [
    ...faq,
    ...securityQuestions,
    ...spadeQuestions,
    ...features.flatMap((entry) => entry.questions),
  ];
  for (const { question } of sources) {
    if (question in leftOut) continue;
    expect(onPage, question).toContain(question);
  }
});

test("a question left out has its twin on the page", () => {
  for (const twin of Object.values(leftOut)) expect(onPage).toContain(twin);
});

test("no question shows twice, so the page and its FAQPage data list each once", () => {
  expect(onPage.size).toBe(allQuestions.length);
});

test("every topic has questions and its own anchor", () => {
  const ids = questionTopics.map((topic) => topic.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const topic of questionTopics) expect(topic.questions.length).toBeGreaterThan(0);
});

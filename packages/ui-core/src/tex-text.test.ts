import { expect, test } from "vitest";
import { proseMath, texText } from "./tex-text.ts";

test("formulas read as their symbols, scripts and fractions", () => {
  expect(texText("\\sigma^2 = \\frac{1}{n}\\sum_{i=1}^{n}(x_i - \\mu)^2")).toBe(
    "σ² = 1/n∑ᵢ₌₁ⁿ(xᵢ - μ)²",
  );
  expect(texText("\\sqrt{a+b} \\le \\infty")).toBe("√(a+b) ≤ ∞");
  expect(texText("x \\in \\mathbb{R}")).toBe("x ∈ ℝ");
});

test("a script without a raised form is bracketed rather than lost", () => {
  expect(texText("e^{-x}")).toBe("e^(-x)");
  expect(texText("a_{max}")).toBe("aₘₐₓ");
  expect(texText("w_{dB}")).toBe("w_(dB)");
});

test("commands it doesn't know stay as written", () => {
  expect(texText("\\unknownthing{x}")).toBe("\\unknownthingx");
});

test("inline and display math become text; code and prices stay as written", () => {
  const markdown = [
    "The variance is $\\sigma^2$ and costs $5 to $6.",
    "Use `$HOME` here.",
    "$$",
    "E = mc^2",
    "$$",
    "```sh",
    "echo $x$",
    "```",
  ].join("\n");
  expect(proseMath(markdown)).toBe(
    [
      "The variance is σ² and costs $5 to $6.",
      "Use `$HOME` here.",
      "```math",
      "E = mc²",
      "```",
      "```sh",
      "echo $x$",
      "```",
    ].join("\n"),
  );
});

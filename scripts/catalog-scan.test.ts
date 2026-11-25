// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";
import { findLiteral, stripTestItems } from "./catalog-scan.ts";

const word = "A device word that must not be retyped";

test("a test item is skipped but the source after it is still read", () => {
  const source = [
    "fn live() {",
    '    let _ = "A device word that must not be retyped";',
    "}",
    "#[cfg(test)]",
    "mod tests {",
    '    const WORD: &str = "A device word that must not be retyped";',
    "}",
    "fn after() {",
    '    let _ = "A device word that must not be retyped";',
    "}",
  ].join("\n");
  const stripped = stripTestItems(source);
  expect(findLiteral(stripped, word)).toEqual([2, 9]);
  // Line numbers survive the blanking.
  expect(stripped.split("\n")).toHaveLength(source.split("\n").length);
});

test("braces in strings, comments, raw strings and nested blocks do not end an item early", () => {
  const source = [
    "#[cfg(test)]",
    "mod tests {",
    '    fn one() { let _ = "}"; }',
    '    fn two() { /* } */ let json = format!("{{}}"); }',
    '    fn three() { let raw = r#"a } b"#; }',
    "    struct Nested { field: [u8; 2] }",
    "}",
    'fn after() { let _ = "A device word that must not be retyped"; }',
  ].join("\n");
  expect(findLiteral(stripTestItems(source), word)).toEqual([8]);
});

test("an item that is not a module is skipped in one piece", () => {
  const source = [
    "#[cfg(test)]",
    "#[test]",
    "fn helper() {",
    "    #[cfg(test)]",
    '    let _ = "A device word that must not be retyped";',
    "}",
    'fn after() { let _ = "A device word that must not be retyped"; }',
  ].join("\n");
  expect(findLiteral(stripTestItems(source), word)).toEqual([7]);
});

test("a lifetime mention is not a character literal", () => {
  const source = [
    "#[cfg(test)]",
    "mod tests {",
    "    fn borrow<'a>(value: &'a str) -> &'a str { value }",
    "}",
    'fn after() { let _ = "A device word that must not be retyped"; }',
  ].join("\n");
  expect(findLiteral(stripTestItems(source), word)).toEqual([5]);
});

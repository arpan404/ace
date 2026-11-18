import { renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import type { Position } from "@ace/editor";
import { useRevealJump } from "./use-reveal.ts";

/*
 * A jump is a request, not a render. The line or find hit a tab asked for is revealed once when
 * it changes; a callback that comes back with a new identity (as the view's reveal does when a
 * caret's side or the layout moves) must not scroll the reader back to a jump already taken.
 */

/** A probe whose callbacks are new functions on every render, as the view's are. */
function probing() {
  const reveals: Position[] = [];
  const announced: Position[] = [];
  const view = renderHook(
    (props: { line?: number; hit?: { line: number; column: number } }) =>
      useRevealJump({
        line: props.line,
        hit: props.hit,
        reveal: (position: Position) => {
          reveals.push(position);
        },
        announce: (position: Position) => {
          announced.push(position);
        },
      }),
    { initialProps: {} as { line?: number; hit?: { line: number; column: number } } },
  );
  return { view, reveals, announced };
}

test("a go-to-line reveals once until the tab asks for another line", () => {
  const { view, reveals, announced } = probing();
  view.rerender({ line: 12 });

  expect(reveals).toEqual([{ line: 11, column: 0 }]);
  expect(announced).toEqual([{ line: 11, column: 0 }]);

  // The same request through another render, with fresh callbacks, is not a new jump.
  view.rerender({ line: 12 });
  expect(reveals).toHaveLength(1);

  // Another line is another jump.
  view.rerender({ line: 20 });
  expect(reveals).toEqual([
    { line: 11, column: 0 },
    { line: 19, column: 0 },
  ]);
  expect(announced).toHaveLength(2);
});

test("a find hit reveals once until the current hit moves", () => {
  const { view, reveals } = probing();
  view.rerender({ hit: { line: 3, column: 4 } });

  expect(reveals).toEqual([{ line: 3, column: 4 }]);

  // The same hit in a new object is the same request.
  view.rerender({ hit: { line: 3, column: 4 } });
  expect(reveals).toHaveLength(1);

  view.rerender({ hit: { line: 3, column: 9 } });
  expect(reveals).toEqual([
    { line: 3, column: 4 },
    { line: 3, column: 9 },
  ]);
});

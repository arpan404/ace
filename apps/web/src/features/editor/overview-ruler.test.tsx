import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import type { LineMark } from "@ace/ui-core";
import { OverviewRuler } from "./overview-ruler.tsx";

/*
 * The overview ruler follows the layout's revision (wrapping, folding, edits): its change and hit
 * ticks are placed again when the rows move, and a render that only moves the caret places one
 * tick, whatever the number of marks.
 */

const marks = new Map<number, LineMark>(
  Array.from({ length: 5_000 }, (_, index) => [index + 1, "added"] as const),
);

const noHits: never[] = [];

function ruler(props: { revision: number; rowOf(line: number): number; caretLine: number }) {
  return (
    <OverviewRuler
      rows={10_000}
      viewRows={40}
      height={1_000}
      rowsOf={() => 1}
      marks={marks}
      agent={undefined}
      hits={noHits}
      onJump={() => {}}
      {...props}
    />
  );
}

const firstTick = () =>
  document.querySelector<HTMLElement>('[data-overview-tick="added"]')?.style.top;

test("a new layout revision places the ticks again where the rows moved", () => {
  const view = render(ruler({ revision: 1, rowOf: (line) => line, caretLine: 0 }));
  expect(firstTick()).toBe("0px");
  // Wrapping put 2,000 rows above the first change: a new revision.
  view.rerender(ruler({ revision: 2, rowOf: (line) => line + 2_000, caretLine: 0 }));
  expect(firstTick()).toBe("200px");
});

test("a render that only moves the caret places only the caret's tick", () => {
  let placed = 0;
  const rowOf = (line: number) => {
    placed++;
    return line;
  };
  const view = render(ruler({ revision: 1, rowOf, caretLine: 0 }));
  placed = 0;
  view.rerender(ruler({ revision: 1, rowOf, caretLine: 3_000 }));
  expect(placed).toBe(1);
  expect(document.querySelector<HTMLElement>('[data-overview-tick="caret"]')?.style.top).toBe(
    "300px",
  );
});

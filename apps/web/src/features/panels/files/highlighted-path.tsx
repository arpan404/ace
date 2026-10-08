import type { ReactNode } from "react";

/** "config.ts" with the characters a fuzzy query matched in full ink. */
export function Highlighted(props: { text: string; offset: number; positions: readonly number[] }) {
  if (!props.positions.length) return props.text;
  const hits = new Set(props.positions.map((position) => position - props.offset));
  const parts: ReactNode[] = [];
  let run = "";
  let lit = false;
  const flush = (index: number) => {
    if (!run) return;
    parts.push(
      lit ? (
        <b key={index} className="font-medium text-foreground">
          {run}
        </b>
      ) : (
        run
      ),
    );
    run = "";
  };
  for (let index = 0; index < props.text.length; index++) {
    const hit = hits.has(index);
    if (hit !== lit) {
      flush(index);
      lit = hit;
    }
    run += props.text[index];
  }
  flush(props.text.length);
  return parts;
}

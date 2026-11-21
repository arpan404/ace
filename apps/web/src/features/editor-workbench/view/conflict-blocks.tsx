import { linesOf } from "@ace/ui-core";
import { Button } from "@/components/ui/button.tsx";
import type { Answer, Clash, TextBuffer } from "../buffers/index.ts";

/*
 * Spec 46's overlapping blocks, answered one by one: each block both sides changed differently
 * shows the person's lines beside the other side's, with Keep mine and Take theirs. Nothing is
 * written to disk: the last answer lands the merged text in the editor as one undoable step,
 * still unsaved.
 */

type Conflict = Extract<Clash, { kind: "conflict" }>;

interface Block {
  index: number;
  /** About where the block starts in the merged file (1-based). */
  line: number;
  mine: string[];
  theirs: string[];
}

/** The conflicting blocks in order, each with the line it starts near. */
export function conflictBlocks(clash: Conflict): Block[] {
  const blocks: Block[] = [];
  let line = 1;
  for (const chunk of clash.chunks) {
    if (chunk.kind === "clean") {
      line += linesOf(chunk.text).length;
      continue;
    }
    const mine = linesOf(chunk.mine);
    blocks.push({ index: blocks.length, line, mine, theirs: linesOf(chunk.theirs) });
    line += mine.length;
  }
  return blocks;
}

export function ConflictBlocks(props: {
  clash: Conflict;
  buffer: TextBuffer;
  /** "Claude Code", or undefined when nobody can be named. */
  theirName: string | undefined;
}) {
  const blocks = conflictBlocks(props.clash);
  const theirs = props.theirName ? `${props.theirName}'s` : "On disk";
  const answer = (index: number, given: Answer) => void props.buffer.answer(index, given);
  return (
    <div
      role="region"
      aria-label="Overlapping changes"
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3"
    >
      {blocks.map((block) => {
        const given = props.clash.answers[block.index];
        return (
          <section
            key={block.index}
            aria-label={`Overlap ${block.index + 1} of ${blocks.length}, near line ${block.line}`}
            data-answer={given}
            className="rounded-sm border border-border"
          >
            <header className="flex h-8 items-center gap-2 border-b border-border pr-1.5 pl-3 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {blocks.length > 1 ? `${block.index + 1} of ${blocks.length} · ` : ""}Near line{" "}
                {block.line}
              </span>
              <Button
                size="sm"
                variant={given === "mine" ? "secondary" : "ghost"}
                aria-pressed={given === "mine"}
                onClick={() => answer(block.index, "mine")}
              >
                Keep mine
              </Button>
              <Button
                size="sm"
                variant={given === "theirs" ? "secondary" : "ghost"}
                aria-pressed={given === "theirs"}
                onClick={() => answer(block.index, "theirs")}
              >
                Take theirs
              </Button>
            </header>
            <div className="grid grid-cols-2 divide-x divide-border font-mono text-ui">
              <Side title="Yours" lines={block.mine} chosen={given === "mine"} />
              <Side title={theirs} lines={block.theirs} chosen={given === "theirs"} />
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Side(props: { title: string; lines: readonly string[]; chosen: boolean }) {
  return (
    <div className="min-w-0">
      <div className="px-3 pt-1.5 font-sans text-xs font-medium text-subtle-foreground">
        {props.title}
        {props.chosen ? " · kept" : ""}
      </div>
      <pre className="max-h-60 overflow-auto px-3 pb-2 whitespace-pre">
        {props.lines.length ? props.lines.join("\n") : "(nothing)"}
      </pre>
    </div>
  );
}

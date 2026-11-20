import { useEffect, useState } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import type { TextBuffer } from "../buffers/index.ts";

/* A Markdown tab shown rendered (spec 40): its own chunk, so markit's prose loads only then. */

/** The buffer's text rendered, unsaved edits included, read again whenever the buffer changes. */
export function MarkdownPreview(props: { buffer: TextBuffer }) {
  const { buffer } = props;
  const [text, setText] = useState(() => buffer.document()?.text() ?? "");
  useEffect(() => {
    setText(buffer.document()?.text() ?? "");
    return buffer.subscribe(() => setText(buffer.document()?.text() ?? ""));
  }, [buffer]);
  return (
    <div className="min-h-0 flex-1 overflow-auto" tabIndex={-1}>
      <article className="mx-auto w-full max-w-[760px] px-8 py-6 text-base leading-[1.6]">
        <Prose text={text} />
      </article>
    </div>
  );
}

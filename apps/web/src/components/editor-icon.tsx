import { createElement } from "react";
import { editorIcon } from "@/lib/editors.ts";

/** An installed editor's glyph (decorative): its own where the design has one. */
export function EditorIcon(props: { id: string | undefined; size?: number; className?: string }) {
  return createElement(editorIcon(props.id), {
    "aria-hidden": true,
    size: props.size ?? 16,
    ...(props.className ? { className: props.className } : {}),
  });
}

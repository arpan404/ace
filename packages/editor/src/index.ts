export { EditorDocument } from "./document.ts";
export { init, type InitOptions } from "./loader.ts";
export { lineMarks } from "./line-marks.ts";
export { lineChanges, merge3 } from "./merge.ts";
export {
  isEditorError,
  type Applied,
  type Change,
  type EditorError,
  type FindQuery,
  type LineEdit,
  type LineMark,
  type LineChange,
  type LineMarkKind,
  type MergeChunk,
  type MergeResult,
  type Position,
  type Range,
  type Selection,
  type TextReplacement,
} from "./types.ts";

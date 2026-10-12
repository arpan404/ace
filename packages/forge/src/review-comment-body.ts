// Only the exact suffix emitted by ace is metadata. Embedded or similar comments
// remain authored text, including a marker followed by another newline.
const suffix = /\n\n<!-- ace-write:[0-9a-f]{64} -->(?![\s\S])/u;
export function authoredReviewComment(hosted: string): string {
  const marker = suffix.exec(hosted);
  return marker ? hosted.slice(0, marker.index) : hosted;
}
/** Retain the publication identity when changing the authored portion. */
export function hostedReviewCommentEdit(body: string, expectedBody: string): string {
  return body + (suffix.exec(expectedBody)?.[0] ?? "");
}

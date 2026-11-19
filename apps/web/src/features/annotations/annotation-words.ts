/* The words for a draft's or message's browser annotations. */

export const annotationCount = (count: number) =>
  `${count} ${count === 1 ? "annotation" : "annotations"}`;

/** "2 style changes · text changed": the edits previewed on the element, if any. */
export function changeSummary(styles: number, text: boolean): string | undefined {
  const parts = [
    ...(styles ? [`${styles} ${styles === 1 ? "style change" : "style changes"}`] : []),
    ...(text ? ["text changed"] : []),
  ];
  const summary = parts.join(" · ");
  return summary ? `${summary[0]?.toUpperCase() ?? ""}${summary.slice(1)}` : undefined;
}

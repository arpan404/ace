const names = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

/** "Mac", "Mac and Studio", "Mac, Studio and Mini". */
export function joinNames(list: readonly string[]): string {
  return names.format(list).replace(/, and /g, " and ");
}

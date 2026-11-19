/** One item's marker: the request's nonce and the item's index, as a paragraph of its own. */
export const marker = (nonce: string, index: number) => `ACEMEDIA${nonce}N${index}X`;

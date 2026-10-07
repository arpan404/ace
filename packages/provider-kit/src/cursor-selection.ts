/** Legacy selections refer to the single SDK default, never the editor's home. */
export const cursorDefaultInstanceId = "cursor-sdk-default";
export function cursorInstanceId(id: string | undefined): string | undefined {
  return id === "cursor-cli-default" ? cursorDefaultInstanceId : id;
}

/** `ace browser screenshot|record`: where the file went. Pure. */
export function browserArtifactLine(value: { path: string; mimeType: string }): string {
  return `Saved ${value.mimeType === "video/mp4" ? "the recording" : "the screenshot"} to ${value.path}.`;
}

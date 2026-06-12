export const SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT = 512;

export function shouldBuildNativeTimelineRowsOnMainThread(input: {
  readonly hasCompleteSnapshot: boolean;
  readonly rowCount: number;
}): boolean {
  if (input.rowCount <= 0) {
    return false;
  }

  return !input.hasCompleteSnapshot || input.rowCount <= SYNCHRONOUS_NATIVE_TIMELINE_ROW_LIMIT;
}

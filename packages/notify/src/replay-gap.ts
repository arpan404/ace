/**
 * What a batch that does not follow on from the notification cursor is refused with. Live
 * ingestion pauses on it without reporting an error: replay reads the same events in order.
 */
export const replayGap = "Notification replay gap";

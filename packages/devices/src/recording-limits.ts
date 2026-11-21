/** The most one device recording holds, across its parts. */
export const deviceRecordingLimit = 512 * 1024 * 1024;
/** The most one MP4 part ace-media writes holds before it starts the next. */
export const deviceRecordingPartBytes = 64 * 1024 * 1024;

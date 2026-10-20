/*
 * The client half of a live view on the shared media stream (`@ace/browser/live-view`): each
 * source's pictures queued for its views, and one daemon subscription per source however many
 * views show it. Portable: browsers, the client worker and the desktop share it.
 */
export { PictureQueue, type SourcePicture } from "./picture-queue.ts";
export { SharedStreams } from "./shared-streams.ts";

// The command filesystem's public surface inside this package. On POSIX the numbers these take and
// return are handles routed to per-root worker threads (posix-lanes.ts); on Windows they are the
// add-on's descriptors.
export {
  closeCommandFd,
  commandCallOwner,
  commandRootSettled,
  useCommandCallDeadline,
  type CommandCalls,
} from "./posix-calls.ts";
export { directoryFlags, fileFlags } from "./posix-flags.ts";
export { EntryUnavailable, type DirectoryReader, type OpenCommandChild } from "./posix-types.ts";
export {
  commandEntryExists,
  commandEntryIsLink,
  openCommandChild,
  openCommandPath,
  openResolvedDirectory,
  readCommandLink,
} from "./posix-open.ts";
export { DirectoryListingTruncated, directoryReader, listingLimit } from "./posix-listing.ts";
export {
  createCommandDirectory,
  createCommandFile,
  exchangeCommandEntriesThrough,
  linkCommandEntry,
  linkCommandFile,
  makeCommandDirectory,
  removeCommandEntry,
  removeCommandEntryLater,
  renameCommandEntry,
  renameCommandEntryAs,
  replaceCommandFile,
} from "./posix-changes.ts";

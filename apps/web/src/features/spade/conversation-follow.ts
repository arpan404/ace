import {
  SpadeConversationFollow,
  SpadeGroupFollow,
  type SpadeFollowDeps,
  type SpadeFollowLink,
} from "@ace/ui-core/spade-chat";
import { spadeHttp } from "./spade-requests.ts";
import type { SpadeTransport } from "./spade-transport.ts";

/*
 * The web's live follow of a conversation: the shared follow (`@ace/ui-core/spade-chat`) over
 * this window's transport, straight to Spade in the desktop app or through the daemon.
 */

export type FollowDeps = SpadeFollowDeps;

function linkOf(transport: SpadeTransport): SpadeFollowLink {
  return {
    canOpen: () => transport.canOpen(),
    onOpenable: (listener) => transport.onOpenable(listener),
    open: (path, sink) => transport.open(path, sink),
    read: (path) => spadeHttp(transport, "GET", path),
  };
}

/** A bot's conversation, followed live. */
export class ConversationFollow extends SpadeConversationFollow {
  constructor(transport: SpadeTransport, conversation: string, deps: FollowDeps) {
    super(linkOf(transport), conversation, deps);
  }
}

/** A group's conversation (ADR 0132), followed live the same way. */
export class GroupFollow extends SpadeGroupFollow {
  constructor(transport: SpadeTransport, conversation: string, deps: FollowDeps) {
    super(linkOf(transport), conversation, deps);
  }
}

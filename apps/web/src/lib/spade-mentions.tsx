import type { ClientApi } from "@ace/client";
import type { SpadeAgent, SpadeAvatar, SpadeGroup } from "@ace/ui-core/spade-chat";
import { createContext, createElement, use, type ComponentType } from "react";
import { BotFace } from "@/components/bot-face.tsx";
import { SpadeMark } from "@/components/spade-mark.tsx";

/*
 * What a thread's `@` picker and its bot replies need of Spade (ADR 0198): this machine's bots
 * and clubs, and how a bot's face and a club's faces are drawn. Spade's own; the app supplies it
 * (`SpadeMentionsProvider`), so the thread can name bots without importing Spade. With none
 * supplied there are no bots to list, and a face draws from its character alone.
 */

export interface SpadeMentionsApi {
  readBots(client: ClientApi, signal: AbortSignal): Promise<readonly SpadeAgent[]>;
  readClubs(client: ClientApi, signal: AbortSignal): Promise<readonly SpadeGroup[]>;
  Face: ComponentType<{ avatar: SpadeAvatar; size: number; className?: string | undefined }>;
  Faces: ComponentType<{
    members: readonly { agent: string; avatar: SpadeAvatar; away: boolean }[];
    size: number;
  }>;
}

const Api = createContext<SpadeMentionsApi | undefined>(undefined);
export const SpadeMentionsProvider = Api;
export const useSpadeMentions = () => use(Api);

/** A bot's face, as Spade draws it when the app supplies Spade, else from its character. */
export function MentionFace(props: {
  avatar: SpadeAvatar;
  size: number;
  className?: string | undefined;
}) {
  const api = use(Api);
  if (api) return createElement(api.Face, props);
  if (props.avatar.kind === "character")
    return <BotFace face={props.avatar.face} size={props.size} />;
  if (props.avatar.kind === "spade") return <SpadeMark size={props.size} />;
  return <span aria-hidden style={{ width: props.size, height: props.size }} />;
}

/** A club's members' faces, stacked, as Spade draws them. */
export function MentionFaces(props: {
  members: readonly { agent: string; avatar: SpadeAvatar; away: boolean }[];
  size: number;
}) {
  const api = use(Api);
  if (api) return createElement(api.Faces, props);
  const [first] = props.members;
  return first ? <MentionFace avatar={first.avatar} size={props.size} /> : null;
}

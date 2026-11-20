import type { SpadeAvatar } from "@ace/ui-core/spade-chat";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { MentionFace, type SpadeMentionsApi } from "@/lib/spade-mentions.tsx";

/*
 * Spade, as a thread's `@` picker and bot replies reach it (ADR 0194): loaded the first time a
 * face or a list is needed, so the shell carries none of Spade until then.
 */

const load = () => import("@/features/spade/index.ts");
const SpadeFace = deferredComponent(() => load().then((spade) => spade.SpadeFace));
const GroupFaces = deferredComponent(() => load().then((spade) => spade.GroupFaces));

type FaceProps = { avatar: SpadeAvatar; size: number; className?: string | undefined };
type FacesProps = {
  members: readonly { agent: string; avatar: SpadeAvatar; away: boolean }[];
  size: number;
};

function Face(props: FaceProps) {
  return (
    <Suspense fallback={<span aria-hidden style={{ width: props.size, height: props.size }} />}>
      <SpadeFace.Component {...props} />
    </Suspense>
  );
}

function Faces(props: FacesProps) {
  const [first] = props.members;
  return (
    <Suspense fallback={first ? <MentionFace avatar={first.avatar} size={props.size} /> : null}>
      <GroupFaces.Component {...props} />
    </Suspense>
  );
}

export const spadeMentions: SpadeMentionsApi = {
  readBots: async (client, signal) => (await load()).readAgents(client, { signal }),
  readClubs: async (client, signal) => (await load()).readGroups(client, { signal }),
  Face,
  Faces,
};

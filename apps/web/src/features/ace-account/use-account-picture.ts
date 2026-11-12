import { useQuery } from "@tanstack/react-query";
import { useAceAccount, useAceAccountStore } from "./account-context.tsx";

/** A picture as a `data:` address, which every client's content policy allows for images. */
async function dataUrl(picture: Blob): Promise<string> {
  const bytes = new Uint8Array(await picture.arrayBuffer());
  let binary = "";
  // A chunk small enough for `String.fromCharCode`'s argument limit, at the picture's 1 MiB cap.
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return `data:${picture.type};base64,${btoa(binary)}`;
}

/**
 * The signed-in account's profile picture, relayed by ace's account backend, so no third party
 * sees which device shows it. Read once per session; undefined without one, while loading, or
 * when it couldn't be read (the avatar shows initials then).
 */
export function useAccountPicture(): string | undefined {
  const store = useAceAccountStore();
  const { session } = useAceAccount();
  const token = session?.account.picture ? session.token : undefined;
  const query = useQuery({
    queryKey: ["ace-account", "picture", store?.origin, token],
    enabled: Boolean(store && token),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: 1,
    queryFn: async ({ signal }) => {
      if (!store || !token) return null;
      const picture = await store.client.picture(
        token,
        AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      );
      return picture ? await dataUrl(picture) : null;
    },
  });
  return query.data ?? undefined;
}

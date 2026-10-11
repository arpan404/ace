import { openExternal } from "@/boot/open-external.ts";

export const openPullRequestLink = (url: string, onError: () => void) =>
  void openExternal(url).catch(onError);

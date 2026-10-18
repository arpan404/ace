import { ChatCircleTextIcon } from "@phosphor-icons/react";
import { displayAddress } from "@ace/ui-core";
import { Icon } from "@/components/icon.tsx";
import { MenuItem } from "@/components/ui/menu.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { mentionTabInComposer } from "@/lib/composer-insert.ts";
import type { BrowserTabView } from "../sources.ts";

/**
 * "Ask agent about this page": the shown tab goes into the thread's message as an `@` mention,
 * so the agent gets its address, a fresh snapshot and a screenshot with the person's question.
 */
export function AskAgentItem(props: { threadId: string; tab: BrowserTabView | undefined }) {
  const toast = useToast();
  const { tab } = props;
  const page = tab && tab.url && tab.url !== "about:blank" && !tab.private ? tab : undefined;
  return (
    <MenuItem
      icon={<Icon icon={ChatCircleTextIcon} />}
      disabled={!page}
      reason={
        tab?.private ? "Agents are kept out of this tab" : page ? undefined : "No page is open"
      }
      onClick={() => {
        if (!page) return;
        const mentioned = mentionTabInComposer(props.threadId, {
          tabId: page.tabId,
          url: page.url,
          title: page.title || displayAddress(page.url),
        });
        if (!mentioned) toast.error({ title: "Couldn't add the page to your message" });
      }}
    >
      Ask agent about this page
    </MenuItem>
  );
}

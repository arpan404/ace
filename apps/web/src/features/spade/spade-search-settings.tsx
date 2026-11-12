import type { SpadeSearchSettings } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { SettingRow, SettingSection } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { readSearchSettings, removeBraveKey, setBraveKey, setSearxngUrl } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";

const searchKey = ["spade", "search"] as const;

const fault = (error: unknown) => (error instanceof Error ? error.message : "Try again.");

/**
 * Settings › Spade › Web search (spade/docs/design.md, Web search): a Brave Search key, kept in
 * the OS keychain, and the address of the person's own SearXNG. Models whose endpoint searches
 * by itself need neither. A bot whose search found nothing set up links here (`#web-search`).
 */
export function SearchSettings(props: { ready: boolean }) {
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const settings = useQuery({
    queryKey: [...searchKey, machine],
    queryFn: ({ signal }) => readSearchSettings(client, { signal }),
    enabled: props.ready,
  });
  // Opened from a reply's "Set up web search": brought into view once it is drawn, which is
  // after the page's own jump to the anchor (this part loads later).
  const hash = useLocation({ select: (location) => location.hash });
  const loaded = settings.data !== undefined;
  useEffect(() => {
    if (hash === "web-search" && loaded)
      document.getElementById("web-search")?.scrollIntoView({ block: "start" });
  }, [hash, loaded]);
  return (
    <SettingSection label="Web search" anchor="web-search">
      {settings.isError ? (
        <SettingRow
          title="Couldn't read the web search settings"
          description={settings.error.message}
        >
          <Button size="sm" onClick={() => void settings.refetch()}>
            Try again
          </Button>
        </SettingRow>
      ) : (
        <>
          <BraveRow settings={settings.data} />
          <SearxngRow settings={settings.data} />
        </>
      )}
    </SettingSection>
  );
}

/** The Brave Search key: sent once, kept by Spade in the keychain, never shown again. */
function BraveRow(props: { settings: SpadeSearchSettings | undefined }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const toast = useToast();
  const field = useId();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const set = props.settings?.braveKeySet === true;
  const about =
    "Brave's search service, with your own key; Brave gives $5 of searches a month free.";
  const change = async (action: "set" | "remove") => {
    const key = draft.trim();
    // The field empties before the request goes, so the key lives only in this call.
    setDraft("");
    setSending(true);
    try {
      if (action === "set") await setBraveKey(client, key);
      else await removeBraveKey(client);
      await cache.invalidateQueries({ queryKey: searchKey });
    } catch (error) {
      toast.error({
        title: action === "set" ? "Couldn't save the key" : "Couldn't remove the key",
        description: fault(error),
      });
    } finally {
      setSending(false);
    }
  };
  if (props.settings && !props.settings.keychain)
    return (
      <SettingRow
        title="Brave Search key"
        description={`${about} This machine has no keychain: set BRAVE_API_KEY where Spade runs.`}
      />
    );
  return (
    <SettingRow
      title="Brave Search key"
      htmlFor={field}
      description={set ? `Set. ${about}` : about}
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) void change("set");
        }}
      >
        <Input
          id={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={set ? "Replace key" : "Paste key"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending || !props.settings}
          className="w-52"
        />
        <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
          Save
        </Button>
        {set && (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={sending}
            onClick={() => void change("remove")}
          >
            Remove
          </Button>
        )}
      </form>
    </SettingRow>
  );
}

/** The person's own SearXNG: edited in place, saved on Save or Enter, cleared with Remove. */
function SearxngRow(props: { settings: SpadeSearchSettings | undefined }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const field = useId();
  const saved = props.settings?.searxngUrl ?? null;
  const [draft, setDraft] = useState<string>();
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const shown = draft ?? saved ?? "";
  const save = async (url: string | null) => {
    setSending(true);
    setRefusal(undefined);
    try {
      const next = await setSearxngUrl(client, url);
      cache.setQueriesData({ queryKey: searchKey }, next);
      setDraft(undefined);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSending(false);
    }
  };
  const changed = draft !== undefined && draft.trim() !== (saved ?? "");
  return (
    <SettingRow
      title="SearXNG"
      htmlFor={field}
      description={
        refusal ? (
          <span role="alert" className="text-destructive">
            {refusal}
          </span>
        ) : (
          "A search engine you run yourself, free and without a key; its settings must allow JSON results."
        )
      }
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) void save(draft?.trim() || null);
        }}
      >
        <Input
          id={field}
          type="url"
          spellCheck={false}
          placeholder="http://localhost:8888"
          value={shown}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending || !props.settings}
          className="w-52"
        />
        <Button size="sm" type="submit" disabled={sending || !changed}>
          Save
        </Button>
        {saved && (
          <Button
            size="sm"
            variant="ghost"
            tone="danger"
            disabled={sending}
            onClick={() => void save(null)}
          >
            Remove
          </Button>
        )}
      </form>
    </SettingRow>
  );
}

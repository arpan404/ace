import type { SpadeSearchSettings } from "@ace/ui-core/spade-chat";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { SettingCard, SettingNote, SettingRow, settingsGroup } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { readSearchSettings, removeBraveKey, setBraveKey, setSearxngUrl } from "./spade-api.ts";
import { useSpadeClient, useSpadeMachine } from "./spade-machine.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import {
  CouldNotRead,
  fault,
  Refusal,
  SpadeNotRunning,
  useSpadeRunning,
} from "./spade-settings-rows.tsx";

const searchKey = ["spade", "search"] as const;

type Engine = "brave" | "searxng" | "off";

/** What Spade searches with now: its own SearXNG first, then Brave (spade/docs/design.md). */
function engineOf(settings: SpadeSearchSettings): Engine {
  if (settings.searxngUrl) return "searxng";
  if (settings.braveKeySet) return "brave";
  return "off";
}

/**
 * Settings › Spade › Web search: one choice (Brave with the person's key, kept in the OS
 * keychain; their own SearXNG; or off), then only the field it needs. Help shows only when a
 * save fails, under the field. Models whose endpoint searches by itself need neither.
 */
export function SearchSettings() {
  const { line, reading } = useSpadeRunning();
  const machine = useSpadeMachine().key;
  const client = useSpadeClient();
  const settings = useQuery({
    queryKey: [...searchKey, machine],
    queryFn: ({ signal }) => readSearchSettings(client, { signal }),
    enabled: line.ready,
  });
  if (!line.ready && !reading)
    return <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />;
  return (
    <div className={settingsGroup} id="web-search">
      <SettingCard>
        {settings.isError ? (
          <CouldNotRead
            what="the web search settings"
            error={settings.error}
            retry={() => void settings.refetch()}
          />
        ) : settings.data ? (
          <SearchChoice key={engineOf(settings.data)} settings={settings.data} />
        ) : (
          <LoadingRows label="Web search" rows={2} />
        )}
      </SettingCard>
    </div>
  );
}

/** The choice, and what it needs: Brave's key, SearXNG's address, or nothing. */
function SearchChoice(props: { settings: SpadeSearchSettings }) {
  const { settings } = props;
  const saved = engineOf(settings);
  const [engine, setEngine] = useState<Engine>(saved);
  return (
    <>
      <SettingRow title="Search with" density="compact" inline>
        <SegmentedControl<Engine>
          label="Search with"
          size="sm"
          value={engine}
          options={[
            { value: "brave", label: "Brave" },
            { value: "searxng", label: "SearXNG" },
            { value: "off", label: "Off" },
          ]}
          onValueChange={setEngine}
        />
      </SettingRow>
      {engine === "brave" && <BraveRow settings={settings} />}
      {engine === "searxng" && <SearxngRow settings={settings} />}
      {engine === "off" && <OffRow settings={settings} />}
    </>
  );
}

/** Puts what Spade answered in place of what was read. */
function useSaved() {
  const cache = useQueryClient();
  return {
    put: (next: SpadeSearchSettings) => cache.setQueriesData({ queryKey: searchKey }, next),
    reread: () => cache.invalidateQueries({ queryKey: searchKey }),
  };
}

/**
 * Brave's key: sent once, kept by Spade in the keychain, never shown again. Saving it while a
 * SearXNG address is set forgets the address, since Spade asks SearXNG first.
 */
function BraveRow(props: { settings: SpadeSearchSettings }) {
  const { settings } = props;
  const client = useSpadeClient();
  const saved = useSaved();
  const field = useId();
  const [draft, setDraft] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const run = async (step: () => Promise<unknown>) => {
    setSending(true);
    setRefusal(undefined);
    try {
      await step();
      if (settings.searxngUrl) saved.put(await setSearxngUrl(client, null));
      setReplacing(false);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSending(false);
      await saved.reread();
    }
  };
  if (!settings.keychain)
    return (
      <SettingRow
        title="Key"
        description="Set BRAVE_API_KEY where Spade runs: this machine has no keychain."
        density="compact"
      />
    );
  if (settings.braveKeySet && !replacing)
    return (
      <SettingRow
        title="Key"
        description={refusal ? <Refusal>{refusal}</Refusal> : "Saved in the keychain"}
        density="compact"
        inline
      >
        {settings.searxngUrl && (
          <Button size="sm" disabled={sending} onClick={() => void run(async () => {})}>
            Use Brave
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => setReplacing(true)}>
          Replace
        </Button>
        <Button
          size="sm"
          variant="ghost"
          tone="danger"
          aria-label="Remove key"
          disabled={sending}
          onClick={() => void run(() => removeBraveKey(client))}
        >
          Remove
        </Button>
      </SettingRow>
    );
  return (
    <SettingRow
      title="Key"
      htmlFor={field}
      description={refusal && <Refusal>{refusal}</Refusal>}
      density="compact"
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const key = draft.trim();
          if (!key) return;
          // The field empties before the request goes, so the key lives only in this call.
          setDraft("");
          void run(() => setBraveKey(client, key));
        }}
      >
        <Input
          id={field}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste key"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending}
          className="w-52"
        />
        {replacing && (
          <Button size="sm" variant="ghost" onClick={() => setReplacing(false)}>
            Cancel
          </Button>
        )}
        <Button size="sm" type="submit" disabled={sending || !draft.trim()}>
          Save
        </Button>
      </form>
    </SettingRow>
  );
}

/** The person's own SearXNG: its address, saved on Save or Enter; a refusal says the fix. */
function SearxngRow(props: { settings: SpadeSearchSettings }) {
  const client = useSpadeClient();
  const saved = useSaved();
  const field = useId();
  const current = props.settings.searxngUrl ?? "";
  const [draft, setDraft] = useState(current);
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const changed = draft.trim() !== current && draft.trim() !== "";
  const save = async () => {
    setSending(true);
    setRefusal(undefined);
    try {
      saved.put(await setSearxngUrl(client, draft.trim()));
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSending(false);
    }
  };
  return (
    <SettingRow
      title="Address"
      htmlFor={field}
      description={refusal && <Refusal>{refusal}</Refusal>}
      density="compact"
    >
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) void save();
        }}
      >
        <Input
          id={field}
          type="url"
          spellCheck={false}
          placeholder="http://localhost:8888"
          value={draft}
          aria-invalid={refusal ? true : undefined}
          onChange={(event) => setDraft(event.target.value)}
          disabled={sending}
          className="w-52"
        />
        <Button size="sm" type="submit" disabled={sending || !changed}>
          Save
        </Button>
      </form>
    </SettingRow>
  );
}

/**
 * Off: bots can't search, and say so when they need to. Turning it off from Brave or SearXNG
 * forgets the address and removes the key, once asked.
 */
function OffRow(props: { settings: SpadeSearchSettings }) {
  const { settings } = props;
  const client = useSpadeClient();
  const saved = useSaved();
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const on = engineOf(settings) !== "off";
  const turnOff = async () => {
    setSending(true);
    setRefusal(undefined);
    try {
      if (settings.searxngUrl) saved.put(await setSearxngUrl(client, null));
      if (settings.braveKeySet && settings.keychain) await removeBraveKey(client);
    } catch (error) {
      setRefusal(fault(error));
    } finally {
      setSending(false);
      await saved.reread();
    }
  };
  if (!on)
    return <SettingNote>Bots can't search the web. They say so when they need to.</SettingNote>;
  return (
    <SettingRow
      title="Turn off web search"
      description={
        refusal ? (
          <Refusal>{refusal}</Refusal>
        ) : settings.braveKeySet && settings.keychain ? (
          "Brave's key is removed from the keychain"
        ) : undefined
      }
      density="compact"
      inline
    >
      <Button size="sm" tone="danger" disabled={sending} onClick={() => void turnOff()}>
        Turn off
      </Button>
    </SettingRow>
  );
}

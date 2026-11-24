import { XIcon } from "@ace/icons";
import { useState } from "react";
import { isStandingRefusal } from "@/boot/person-standing.ts";
import { ConfirmPerson } from "@/features/ace-account/index.ts";
import { SettingDisclosure, SettingFooter } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { useSpadeClient } from "./spade-machine.tsx";
import { fault } from "./spade-profile-actions.ts";
import { Refusal } from "./spade-settings-rows.tsx";

/**
 * The apps bots never use through Computer use (ADR 0171, amendment 7), under its switch in
 * Settings › Spade: the one safety net left once Computer use is on. Folded behind its count;
 * open, each app as a compact removable chip, and a name to add. Removing one lets bots use it,
 * so it is the person's alone: Confirm it's you shows in the list's foot until they do.
 */
export function NeverApps(props: {
  apps: readonly string[];
  save(apps: readonly string[]): Promise<unknown>;
}) {
  const client = useSpadeClient();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [confirming, setConfirming] = useState<readonly string[]>();
  const save = async (apps: readonly string[]) => {
    setSaving(true);
    setRefusal(undefined);
    setConfirming(undefined);
    try {
      await props.save(apps);
      return true;
    } catch (error) {
      const message = fault(error);
      if (isStandingRefusal(message)) setConfirming(apps);
      else setRefusal(message);
      return false;
    } finally {
      setSaving(false);
    }
  };
  const add = async () => {
    const app = name.trim();
    if (!app) return;
    if (await save([...props.apps, app])) setName("");
  };
  const count = `${props.apps.length} ${props.apps.length === 1 ? "app" : "apps"}`;
  return (
    <SettingDisclosure title={`Never let bots use · ${count}`}>
      <p data-setting-slot="" className="pb-2 text-xs text-muted-foreground">
        Bots never use these apps, even with Computer use on.
      </p>
      <ul
        data-setting-slot=""
        aria-label="Apps bots never use"
        className="flex flex-wrap gap-1.5 pb-2.5"
      >
        {props.apps.map((app) => (
          <li
            key={app}
            className="inline-flex items-center gap-1 rounded-md border border-border-soft bg-secondary/50 py-1 pr-1 pl-2.5 text-xs text-foreground"
          >
            <span>{app}</span>
            <button
              type="button"
              disabled={saving}
              aria-label={`Remove ${app}`}
              onClick={() => void save(props.apps.filter((each) => each !== app))}
              className="grid size-4.5 place-items-center rounded-sm text-subtle-foreground transition-colors hover:bg-accent hover:text-destructive focus-ring disabled:opacity-50"
            >
              <XIcon aria-hidden size={11} />
            </button>
          </li>
        ))}
      </ul>
      <SettingFooter>
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <div className="flex items-center gap-2">
            <Input
              aria-label="App to never use"
              placeholder="App name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="flex-1"
            />
            <Button type="submit" size="sm" variant="secondary" disabled={saving || !name.trim()}>
              Add
            </Button>
          </div>
          {confirming !== undefined && (
            <ConfirmPerson client={client} onConfirmed={() => void save(confirming)} />
          )}
          {refusal && <Refusal>{refusal}</Refusal>}
        </form>
      </SettingFooter>
    </SettingDisclosure>
  );
}

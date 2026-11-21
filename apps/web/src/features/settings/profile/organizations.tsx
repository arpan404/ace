import { useState } from "react";
import {
  SettingList,
  SettingListItem,
  SettingNote,
  SettingSection,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { roleWord, useAceAccount, useSpace } from "@/features/ace-account/index.ts";
import { orgFailure } from "@/features/ace-org/index.ts";

/**
 * Profile's organizations (ADR 0206 §1.1, §1.5): the person's spaces, which one this window
 * shows, and making a new organization. Anyone signed in with a verified email may make one
 * (the founder's call for M4); they become its owner. Leaving is on the organization's Members.
 */
export function OrganizationsSection() {
  const { spaces, shown, choose, calls, refresh, failed } = useSpace();
  const verified = useAceAccount().session?.account.emailVerified === true;
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!calls) return null;
  const create = async () => {
    const wanted = name.trim();
    if (!wanted) return;
    setBusy(true);
    setError("");
    try {
      const made = await calls.orgs.create(calls.token, wanted, AbortSignal.timeout(15_000));
      setName("");
      await refresh();
      choose(made.id);
    } catch (cause) {
      failed(cause);
      setError(orgFailure(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingSection
      label="Organizations"
      anchor="organizations"
      note="Switching shows that organization's hosts and shared bots in this window. It deletes nothing."
    >
      <SettingList aria-label="Spaces">
        <SpaceRow
          name="Personal"
          line="Your own machines and bots"
          current={shown?.id === "personal"}
          onChoose={() => choose("personal")}
        />
        {(spaces ?? []).map((space) => (
          <SpaceRow
            key={space.id}
            name={space.name || "Unnamed organization"}
            line={[
              roleWord(space.role),
              space.directoryManaged ? "Set by your identity provider" : undefined,
              space.noOwner ? "No owner: ace support can name one" : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            current={shown?.id === space.id}
            onChoose={() => choose(space.id)}
          />
        ))}
      </SettingList>
      {verified ? (
        <form
          className="flex min-h-(--setting-row-height) items-center gap-2 py-(--setting-row-y)"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Input
            aria-label="New organization's name"
            placeholder="New organization's name"
            value={name}
            maxLength={128}
            onChange={(event) => setName(event.target.value)}
            className="flex-1"
          />
          <Button type="submit" size="sm" variant="primary" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </form>
      ) : (
        <SettingNote>Verify your account's email address to create an organization.</SettingNote>
      )}
      {error && (
        <SettingNote role="alert" className="text-destructive">
          {error}
        </SettingNote>
      )}
    </SettingSection>
  );
}

function SpaceRow(props: { name: string; line: string; current: boolean; onChoose(): void }) {
  return (
    <SettingListItem className="gap-3" aria-current={props.current ? "true" : undefined}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-ui font-medium text-foreground">{props.name}</span>
        <span className="truncate text-xs text-subtle-foreground">{props.line}</span>
      </span>
      {props.current ? (
        <span className="shrink-0 text-ui text-muted-foreground">Shown here</span>
      ) : (
        <Button size="sm" variant="ghost" onClick={props.onChoose}>
          Switch
        </Button>
      )}
    </SettingListItem>
  );
}

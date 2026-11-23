import {
  spadeProviderCounts,
  spadeProviderGroups,
  spadeProviderProblem,
  spadeProviderState,
  type SpadeProviderGroup,
} from "@ace/ui-core/spade-chat";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { SettingAddRow, SettingCard, settingsGroup } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListRowFrame, rowLinkClass } from "@/features/provider-setup/index.ts";
import { AccountStateWords, ProvidersGroup } from "@/features/settings/index.ts";
import { useNow } from "@/lib/time.ts";
import { part } from "@/lib/suit-part.ts";
import { KeyDialog } from "./spade-account-dialogs.tsx";
import { AddEndpointDialog } from "./spade-add-endpoint.tsx";
import { ChatgptSignInDialog } from "./spade-chatgpt-sign-in.tsx";
import { SpadeProviderMark } from "./spade-marks.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { GlobalRoles } from "./spade-settings-roles.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

/**
 * Settings › Spade › Models, laid out as ace's Providers page (ADR 0214): every provider as one
 * row (its mark, name, where it stands, its accounts and bots, and the one fix it needs), each
 * opening its own page; Add a provider; then the roles, which pick from those providers' models.
 */
export function SpadeModelsSettings() {
  const { line, reading } = useSpadeRunning();
  const models = useSpadeModels(line.ready);
  const now = useNow();
  const [adding, setAdding] = useState<"provider" | "chatgpt">();
  if (!line.ready && !reading)
    return <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />;
  if (!models.data)
    return (
      <div className={settingsGroup}>
        <SettingCard>
          {models.isError ? (
            <CouldNotRead
              what="Spade's providers"
              error={models.error}
              retry={() => void models.refetch()}
            />
          ) : (
            <LoadingRows label="Providers" rows={3} />
          )}
        </SettingCard>
      </div>
    );
  const { data } = models;
  const groups = spadeProviderGroups(data.endpoints, data.presets);
  // With an OpenAI provider, its own page adds ChatGPT sign-ins.
  const chatgpt =
    data.signIn.includes("chatgpt") && !groups.some((group) => group.provider === "openai");
  return (
    <>
      <ProvidersGroup label="Providers" aside={groups.length || undefined}>
        {groups.map((group) => (
          <ProviderRow key={group.key} group={group} keychain={data.keychain} now={now} />
        ))}
        <SettingAddRow onClick={() => setAdding("provider")}>Add a provider</SettingAddRow>
        {chatgpt && (
          <SettingAddRow onClick={() => setAdding("chatgpt")}>Sign in with ChatGPT</SettingAddRow>
        )}
      </ProvidersGroup>
      <GlobalRoles fastModel={data.fastModel} />
      {adding === "provider" && (
        <AddEndpointDialog presets={data.presets} onClose={() => setAdding(undefined)} />
      )}
      {adding === "chatgpt" && <ChatgptSignInDialog onClose={() => setAdding(undefined)} />}
    </>
  );
}

/**
 * A provider on the list, in ace's provider row: where it stands in words ("Ready", "Key
 * missing", "1 at the usage limit"), its accounts and bots, and at the right the one fix it
 * needs, right here; the whole row opens its page.
 */
function ProviderRow(props: { group: SpadeProviderGroup; keychain: boolean; now: number }) {
  const { group } = props;
  const [fixing, setFixing] = useState(false);
  const state = spadeProviderState(group.accounts, props.keychain, props.now);
  const counts = spadeProviderCounts(group.accounts);
  const problem = spadeProviderProblem(group.accounts, props.keychain, props.now);
  const first = group.accounts[0];
  return (
    <ListRowFrame
      mark={first && <SpadeProviderMark account={first} name={group.name} size={20} decorative />}
      name={group.name}
      link={
        <Link
          to="/settings/spade/models/$provider"
          params={{ provider: group.key }}
          aria-label={group.name}
          {...part("link", undefined, "row")}
          className={rowLinkClass}
        >
          {group.name}
        </Link>
      }
      sub={
        <>
          <AccountStateWords tone={state.tone}>{state.text}</AccountStateWords>
          {counts && <> · {counts}</>}
        </>
      }
      right={
        problem && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`${problem.fix === "key" ? "Add a key to" : "Sign in to"} ${problem.account.name}`}
            onClick={() => setFixing(true)}
          >
            {problem.fix === "key" ? "Add key" : "Sign in"}
          </Button>
        )
      }
    >
      {fixing &&
        problem &&
        (problem.fix === "key" ? (
          <KeyDialog
            account={problem.account}
            provider={group.name}
            onClose={() => setFixing(false)}
          />
        ) : (
          <ChatgptSignInDialog account={problem.account.id} onClose={() => setFixing(false)} />
        ))}
    </ListRowFrame>
  );
}

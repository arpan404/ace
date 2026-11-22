import { spadeProviderGroups } from "@ace/ui-core/spade-chat";
import { useState } from "react";
import { SettingAddRow, SettingCard, settingsGroup } from "@/components/setting-row.tsx";
import { AddEndpointDialog } from "./spade-add-endpoint.tsx";
import { ChatgptSignInDialog } from "./spade-chatgpt-sign-in.tsx";
import { ProviderSection } from "./spade-provider-settings.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { GlobalRoles } from "./spade-settings-roles.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

/**
 * Settings › Spade › Models, in the order setup goes (ADR 0213): each provider with its accounts
 * (how each signs in, the bots on it, its models), then Add a provider, from a preset or by
 * address, and Sign in with ChatGPT while no OpenAI account is there to add it from, then the
 * models for every bot's other work, which pick from those accounts.
 */
export function SpadeModelsSettings() {
  const { line, reading } = useSpadeRunning();
  const models = useSpadeModels(line.ready);
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
  // With an OpenAI group, its Add an account offers the sign-in.
  const chatgpt =
    data.signIn.includes("chatgpt") && !groups.some((group) => group.provider === "openai");
  return (
    <>
      {groups.map((group) => (
        <ProviderSection
          key={group.key}
          group={group}
          presets={data.presets}
          keychain={data.keychain}
          signIn={data.signIn}
        />
      ))}
      <div className={settingsGroup}>
        <SettingCard>
          <SettingAddRow onClick={() => setAdding("provider")}>Add a provider</SettingAddRow>
          {chatgpt && (
            <SettingAddRow onClick={() => setAdding("chatgpt")}>Sign in with ChatGPT</SettingAddRow>
          )}
        </SettingCard>
      </div>
      <GlobalRoles fastModel={data.fastModel} />
      {adding === "provider" && (
        <AddEndpointDialog presets={data.presets} onClose={() => setAdding(undefined)} />
      )}
      {adding === "chatgpt" && <ChatgptSignInDialog onClose={() => setAdding(undefined)} />}
    </>
  );
}

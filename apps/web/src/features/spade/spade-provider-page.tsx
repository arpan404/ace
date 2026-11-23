import {
  spadeProviderCounts,
  spadeProviderGroups,
  spadeProviderProblem,
  type SpadeAccountFix,
  type SpadeModels,
  type SpadeProviderGroup,
} from "@ace/ui-core/spade-chat";
import { CaretLeftIcon } from "@ace/icons";
import { Link, Navigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  SettingAddRow,
  SettingCard,
  SettingList,
  SettingSection,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PageMark, ProblemLine, SettingsBody } from "@/features/settings/index.ts";
import { useSpadeShown } from "@/lib/spade-available.ts";
import { part } from "@/lib/suit-part.ts";
import { useNow } from "@/lib/time.ts";
import { AddAccountDialog, article } from "./spade-add-account.tsx";
import { SpadeAccountRow } from "./spade-account-row.tsx";
import { SpadeProviderMark } from "./spade-marks.tsx";
import { SpadeProviderModels } from "./spade-provider-models.tsx";
import { LoadingRows } from "./spade-settings-loading.tsx";
import { CouldNotRead, SpadeNotRunning, useSpadeRunning } from "./spade-settings-rows.tsx";
import { useSpadeModels } from "./use-spade-models.ts";

const back = (
  <Link
    to="/settings/spade/models"
    aria-label="Back to Models"
    {...part("link", undefined, "back")}
    className="inline-flex items-center gap-1 rounded-xs text-muted-foreground focus-ring hover:text-foreground"
  >
    <CaretLeftIcon aria-hidden size={12} />
    Models
  </Link>
);

/**
 * One of Spade's providers on its own page, as ace's provider pages are: the fix it needs first,
 * then its accounts and the models bots may use on each. Hidden on this machine (ADR 0139): no
 * Spade settings.
 */
export function SpadeProviderScreen(props: { id: string }) {
  const shown = useSpadeShown();
  const { line, reading } = useSpadeRunning();
  const models = useSpadeModels(line.ready);
  if (shown === false) return <Navigate to="/settings" replace />;
  const group = models.data
    ? spadeProviderGroups(models.data.endpoints, models.data.presets).find(
        (each) => each.key === props.id,
      )
    : undefined;
  if (models.data && group) return <ProviderPage group={group} data={models.data} />;
  return (
    <SettingsBody page={models.data ? "Provider not found" : "Models"} back={back}>
      {!line.ready && !reading ? (
        <SpadeNotRunning sentence={line.sentence} canTurnOn={line.canTurnOn} />
      ) : models.data ? (
        <p role="alert" className="mt-4 text-muted-foreground">
          Spade has no account with this provider.
        </p>
      ) : (
        <div className={settingsGroup}>
          <SettingCard>
            {models.isError ? (
              <CouldNotRead
                what="Spade's providers"
                error={models.error}
                retry={() => void models.refetch()}
              />
            ) : (
              <LoadingRows label="Accounts" rows={3} />
            )}
          </SettingCard>
        </div>
      )}
    </SettingsBody>
  );
}

function ProviderPage(props: { group: SpadeProviderGroup; data: SpadeModels }) {
  const { group, data } = props;
  const now = useNow();
  const [adding, setAdding] = useState(false);
  // The problem line's button opens the fix on the account it names.
  const [fixing, setFixing] = useState<{ account: string; fix: SpadeAccountFix }>();
  const problem = spadeProviderProblem(group.accounts, data.keychain, now);
  const preset = data.presets.find((each) => each.id === group.provider);
  const chatgpt = group.provider === "openai" && data.signIn.includes("chatgpt");
  const counts = spadeProviderCounts(group.accounts);
  const first = group.accounts[0];
  return (
    <SettingsBody
      page={group.name}
      back={back}
      icon={
        first && (
          <PageMark>
            <SpadeProviderMark account={first} name={group.name} size={20} />
          </PageMark>
        )
      }
      lede={counts && <span className="text-xs">{counts}</span>}
    >
      <div className="fx-view-in">
        {problem && (
          <ProblemLine
            fix={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setFixing({ account: problem.account.id, fix: problem.fix })}
              >
                {problem.fix === "key" ? "Add key" : "Sign in"}
              </Button>
            }
          >
            {problem.text}
          </ProblemLine>
        )}
        <SettingSection label="Accounts">
          <SettingList aria-label={`${group.name} accounts`}>
            {group.accounts.map((account) => (
              <SpadeAccountRow
                key={account.id}
                account={account}
                provider={group.name}
                keychain={data.keychain}
                now={now}
                fixing={fixing?.account === account.id ? fixing.fix : undefined}
                onFixed={() => setFixing(undefined)}
              />
            ))}
            {(preset || chatgpt) && (
              <li>
                <SettingAddRow
                  aria-label={`Add ${article(group.name)} ${group.name} account`}
                  onClick={() => setAdding(true)}
                >
                  Add account
                </SettingAddRow>
              </li>
            )}
          </SettingList>
        </SettingSection>
        <SettingSection label="Models">
          <SpadeProviderModels accounts={group.accounts} />
        </SettingSection>
      </div>
      {adding && (
        <AddAccountDialog
          name={group.name}
          preset={preset}
          chatgpt={chatgpt}
          onClose={() => setAdding(false)}
        />
      )}
    </SettingsBody>
  );
}

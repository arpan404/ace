import {
  spadeFirstUsableModel,
  spadeFirstUsableWords,
  spadeSetupSentence,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import {
  SettingCard,
  SettingRow,
  SettingSection,
  settingsGroup,
} from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  setFastModel,
  setNewBotModel,
  setSpeechModel,
  setTranscriptionModel,
} from "./spade-api.ts";
import { VoiceRows } from "./spade-voice-settings.tsx";
import { ReviewRows, SpendingSection, useOversightSettings } from "./spade-oversight-settings.tsx";
import { ReachSection, SpendAlertRow } from "./spade-reach-settings.tsx";
import { SearchUsageLine } from "./spade-search-usage.tsx";
import { LoadingRows, SwitchSkeleton } from "./spade-settings-loading.tsx";
import { setShowWork, useShowWork } from "./spade-show-work.ts";
import { CouldNotRead, ModelSettingRow, useSpadeRunning } from "./spade-settings-rows.tsx";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * Settings › Spade › General:
 * 1. Top card: Run Spade on this machine + Show work in chat
 * 2. Defaults: Model for new bots, Fast model, Review every bot's writes
 * 3. Voice: Speak replies, Voice, Transcription, Speech
 * 4. Notifications & Morning brief (ADR 0195)
 * 5. Spending & ace web search usage (ADR 0166, ADR 0210)
 */
export function SpadeSettings() {
  const runId = useId();
  const workId = useId();
  const showWork = useShowWork();
  const { status, enabled, setEnabled, saving, line, reading } = useSpadeRunning();
  const models = useSpadeModels(line.ready);
  const oversight = useOversightSettings(line.ready);
  // The switch says on or off; words only for what it can't (starting, stopped, waiting).
  const sentence = line.ready
    ? spadeSetupSentence(status)
    : enabled === false || reading
      ? undefined
      : line.sentence;
  const loading = reading || (line.ready && (models.isPending || oversight.oversight.isPending));
  return (
    <>
      <div className={settingsGroup}>
        <SettingCard>
          <SettingRow
            title="Run Spade on this machine"
            description={sentence}
            htmlFor={runId}
            density="compact"
            inline
          >
            {enabled === undefined ? (
              <SwitchSkeleton />
            ) : (
              <Switch
                id={runId}
                checked={enabled}
                disabled={saving}
                onCheckedChange={(checked) => void setEnabled(checked)}
              />
            )}
          </SettingRow>
          <SettingRow
            title="Show work in chat"
            description="Show each reply's steps and notes inline under the message"
            htmlFor={workId}
            density="compact"
            inline
          >
            <Switch id={workId} checked={showWork} onCheckedChange={setShowWork} />
          </SettingRow>
        </SettingCard>
      </div>

      {(line.ready || loading) && (
        <DefaultsSection
          loading={loading}
          models={models}
          oversight={oversight}
          review={<ReviewRows settings={oversight} />}
        />
      )}

      {line.ready && !loading && models.data && <VoiceSection models={models.data} />}

      {line.ready && <ReachSection ready={line.ready} />}

      {(line.ready || reading) && (
        <SpendingSection
          settings={oversight}
          footer={
            <>
              <SearchUsageLine ready={line.ready} />
              <SpendAlertRow ready={line.ready} />
            </>
          }
        />
      )}
    </>
  );
}

function DefaultsSection(props: {
  loading: boolean;
  models: ReturnType<typeof useSpadeModels>;
  oversight: ReturnType<typeof useOversightSettings>;
  review: ReactNode;
}) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: modelsKey });
  const saved = (put: (model: string | null) => Promise<void>) => async (model: string | null) => {
    try {
      await put(model);
    } finally {
      await refresh();
    }
  };
  return (
    <SettingSection label="Defaults" anchor="defaults">
      {props.loading && <LoadingRows label="Spade's models" rows={3} />}
      {!props.loading && props.models.isError && (
        <CouldNotRead
          what="Spade's models"
          error={props.models.error}
          retry={() => void props.models.refetch()}
        />
      )}
      {!props.loading && props.models.data && (
        <>
          <ModelSettingRow
            title="Model for new bots"
            description="Default model used when you create a new bot"
            value={props.models.data.newBotModel}
            none={spadeFirstUsableWords(spadeFirstUsableModel(props.models.data.endpoints))}
            follows={spadeFirstUsableModel(props.models.data.endpoints)}
            forBots
            save={saved((model) => setNewBotModel(client, model))}
          />
          <ModelSettingRow
            title="Fast model"
            description="Titles and other small jobs"
            value={props.models.data.fastModel}
            none="Each bot's own"
            save={saved((model) => setFastModel(client, model))}
          />
          {props.review}
        </>
      )}
      {props.oversight.oversight.isError && (
        <CouldNotRead
          what="the review settings"
          error={props.oversight.oversight.error}
          retry={() => void props.oversight.oversight.refetch()}
        />
      )}
    </SettingSection>
  );
}

function VoiceSection(props: { models: SpadeModels }) {
  const client = useSpadeClient();
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: modelsKey });
  const saved = (put: (model: string | null) => Promise<void>) => async (model: string | null) => {
    try {
      await put(model);
    } finally {
      await refresh();
    }
  };
  const { models } = props;
  return (
    <SettingSection label="Voice" anchor="voice">
      <VoiceRows speechModel={models.speechModel} />
      <ModelSettingRow
        title="Transcription"
        description="Dictation and voice, when this device can't"
        value={models.transcriptionModel}
        none="Off"
        save={saved((model) => setTranscriptionModel(client, model))}
      />
      <ModelSettingRow
        title="Speech"
        description="Reads replies aloud; uses system voices when off"
        value={models.speechModel}
        none="System voices"
        save={saved((model) => setSpeechModel(client, model))}
      />
    </SettingSection>
  );
}

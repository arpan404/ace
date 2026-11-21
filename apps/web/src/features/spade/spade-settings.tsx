import {
  spadeFirstUsableModel,
  spadeFirstUsableWords,
  spadeSetupSentence,
  type SpadeModels,
} from "@ace/ui-core/spade-chat";
import { useQueryClient } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import { SettingCard, SettingRow, settingsGroup } from "@/components/setting-row.tsx";
import { Switch } from "@/components/ui/switch.tsx";
import {
  setFastModel,
  setNewBotModel,
  setSpeechModel,
  setTranscriptionModel,
} from "./spade-api.ts";
import { VoiceRows } from "./spade-voice-settings.tsx";
import { ReviewRows, SpendingSection, useOversightSettings } from "./spade-oversight-settings.tsx";
import { ReachSection } from "./spade-reach-settings.tsx";
import { LoadingRows, SwitchSkeleton } from "./spade-settings-loading.tsx";
import { CouldNotRead, ModelSettingRow, useSpadeRunning } from "./spade-settings-rows.tsx";
import { modelsKey, useSpadeModels } from "./use-spade-models.ts";
import { useSpadeClient } from "./spade-machine.tsx";

/**
 * Settings › Spade › General: Spade on or off on this machine; the models it starts new bots
 * on and uses for small jobs, transcription and speech, and how replies sound; whether every
 * bot's writes are reviewed (ADR 0135); how Spade reaches the person (ADR 0195); then what every
 * bot spent. While the setting or Spade's state is
 * still being read, the rows hold their place, and the switch shows neither on nor off.
 */
export function SpadeSettings() {
  const id = useId();
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
            htmlFor={id}
            density="compact"
            inline
          >
            {enabled === undefined ? (
              <SwitchSkeleton />
            ) : (
              <Switch
                id={id}
                checked={enabled}
                disabled={saving}
                onCheckedChange={(checked) => void setEnabled(checked)}
              />
            )}
          </SettingRow>
          {loading && <LoadingRows label="Spade's models" rows={4} />}
          {line.ready && models.isError && (
            <CouldNotRead
              what="Spade's models"
              error={models.error}
              retry={() => void models.refetch()}
            />
          )}
          {line.ready && !loading && models.data && (
            <ModelRows models={models.data} review={<ReviewRows settings={oversight} />} />
          )}
          {line.ready && oversight.oversight.isError && (
            <CouldNotRead
              what="the review settings"
              error={oversight.oversight.error}
              retry={() => void oversight.oversight.refetch()}
            />
          )}
        </SettingCard>
      </div>
      {line.ready && <ReachSection ready={line.ready} />}
      {(line.ready || reading) && <SpendingSection settings={oversight} />}
    </>
  );
}

/**
 * The model new bots start on, the fast model, the review switch (`review`), the transcription
 * and speech models, each model one picker, then Speak replies and the voice.
 */
function ModelRows(props: { models: SpadeModels; review: ReactNode }) {
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
    <>
      <ModelSettingRow
        title="Model for new bots"
        value={models.newBotModel}
        none={spadeFirstUsableWords(spadeFirstUsableModel(models.endpoints))}
        follows={spadeFirstUsableModel(models.endpoints)}
        forBots
        save={saved((model) => setNewBotModel(client, model))}
      />
      <ModelSettingRow
        title="Fast model"
        description="Titles and other small jobs"
        value={models.fastModel}
        none="Each bot's own"
        save={saved((model) => setFastModel(client, model))}
      />
      {props.review}
      <ModelSettingRow
        title="Transcription"
        description="Dictation and voice, when this device can't"
        value={models.transcriptionModel}
        none="Off"
        save={saved((model) => setTranscriptionModel(client, model))}
      />
      <ModelSettingRow
        title="Speech"
        description="Reads replies aloud; the system's voices when off"
        value={models.speechModel}
        none="System voices"
        save={saved((model) => setSpeechModel(client, model))}
      />
      <VoiceRows speechModel={models.speechModel} />
    </>
  );
}

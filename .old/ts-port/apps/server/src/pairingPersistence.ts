import { Effect, Layer } from "effect";
import { PairingSessionRepository } from "./persistence/Services/PairingSessions";
import { loadPairingSessionsFromDatabase, persistPairingSessionsToDatabase } from "./pairing";

export const loadPersistedPairingSessions = Effect.gen(function* () {
  const repository = yield* PairingSessionRepository;
  yield* Effect.promise(() => loadPairingSessionsFromDatabase(repository));
});

export const persistPairingSessionsSnapshot = Effect.gen(function* () {
  const repository = yield* PairingSessionRepository;
  yield* Effect.promise(() => persistPairingSessionsToDatabase(repository));
});

export const PairingPersistenceRuntimeLive = Layer.effectDiscard(loadPersistedPairingSessions);

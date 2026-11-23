import Foundation

/// A routine as its profile row and editor show it (`bridge/spade-routines.ts` `routineRow`).
struct SpadeRoutineRow: Decodable, Equatable, Hashable, Identifiable, Sendable {
    let id: String
    let name: String
    let instruction: String
    /// When it runs in words, that it's paused, or that its last run failed.
    let line: String
    let failed: Bool
    let paused: Bool
    /// Nil for a kind of trigger this build doesn't know: the editor keeps it as it is.
    let trigger: SpadeRoutineTrigger?
}

/// The bot's heartbeat: a checklist it goes through every so often, outside quiet hours.
struct SpadeHeartbeatRow: Decodable, Equatable, Sendable {
    struct Quiet: Codable, Equatable, Sendable {
        let start: String
        let end: String
    }
    let enabled: Bool
    let everyMinutes: Int
    let checklist: String
    let quiet: Quiet?
    let line: String
}

/// What `spade.routines` answers: the routines and heartbeat, or why they couldn't be read.
struct SpadeRoutinesAnswer: Decodable, Sendable {
    let ok: Bool
    let routines: [SpadeRoutineRow]?
    let heartbeat: SpadeHeartbeatRow?
    let title: String?
    let message: String?
    var problem: String? { SpadeOutcome(ok: ok, title: title, message: message).problem }
}

/// A bot's routines and heartbeat on its profile (`bridge/spade-routines.ts`). A schedule is
/// sent with the phone's own time zone, which Spade reads it in.
extension ClientModel {
    func spadeRoutines(_ agent: String) async -> SpadeRoutinesAnswer {
        let failed = { (message: String?) in
            SpadeRoutinesAnswer(ok: false, routines: nil, heartbeat: nil, title: "Couldn't read the routines", message: message)
        }
        do {
            return try await service(["type": "spade.routines", "agentId": agent], as: SpadeRoutinesAnswer.self)
        } catch is CancellationError { return failed(nil) }
        catch { return failed(error.localizedDescription) }
    }

    /// A new routine (`id` nil) or a change to one; the trigger goes only when the person changed it.
    func spadeSaveRoutine(_ agent: String, id: String?, draft: SpadeRoutineDraft) async -> SpadeOutcome {
        var payload: [String: Any] = [
            "type": "spade.routine.save", "agentId": agent,
            "name": draft.name.trimmingCharacters(in: .whitespacesAndNewlines),
            "instruction": draft.instruction.trimmingCharacters(in: .whitespacesAndNewlines),
            "timeZone": TimeZone.current.identifier,
        ]
        if let id { payload["id"] = id }
        if let trigger = id == nil ? draft.trigger : draft.changedTrigger {
            var sent: [String: Any] = ["kind": trigger.kind]
            if let schedule = trigger.schedule { sent["schedule"] = schedule }
            if let event = trigger.event { sent["event"] = event }
            payload["trigger"] = sent
        }
        return await spadeRequest(payload, failing: "Couldn't save the routine")
    }

    func spadePauseRoutine(_ id: String, paused: Bool) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.routine.pause", "id": id, "paused": paused],
                           failing: paused ? "Couldn't pause it" : "Couldn't resume it")
    }

    func spadeRunRoutine(_ id: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.routine.run", "id": id], failing: "Couldn't run it")
    }

    func spadeDeleteRoutine(_ id: String) async -> SpadeOutcome {
        await spadeRequest(["type": "spade.routine.delete", "id": id], failing: "Couldn't delete it")
    }

    /// The heartbeat's switch (only `enabled`), or its editor's Save, which turns it on.
    func spadeSaveHeartbeat(_ agent: String, enabled: Bool, everyMinutes: Int? = nil, checklist: String? = nil,
                            quiet: SpadeHeartbeatRow.Quiet?? = nil) async -> SpadeOutcome {
        var payload: [String: Any] = ["type": "spade.heartbeat.save", "agentId": agent, "enabled": enabled]
        // Quiet hours and the interval are meant in the phone's zone now; the switch alone keeps
        // the zone they were set in.
        if everyMinutes != nil || quiet != nil { payload["timeZone"] = TimeZone.current.identifier }
        if let everyMinutes { payload["everyMinutes"] = everyMinutes }
        if let checklist { payload["checklist"] = checklist }
        if let quiet {
            payload["quiet"] = quiet.map { ["start": $0.start, "end": $0.end] } ?? NSNull()
        }
        return await spadeRequest(payload, failing: enabled ? "Couldn't turn the heartbeat on" : "Couldn't turn the heartbeat off")
    }
}

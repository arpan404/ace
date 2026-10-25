import Foundation

/// A paired machine as New thread weighs it: listed in pairing order, the first paired first.
struct NewThreadMachineOption: Equatable, Sendable {
    let hostId: String
    let name: String
    let canOperate: Bool
    /// The runtime's connection state: "ready", "connecting", "reconnecting", "fatal", ...
    let connection: String
    /// Ready, or still on its first connect: a launch doesn't know yet, so it doesn't move.
    var reachable: Bool { ["ready", "connecting", "starting"].contains(connection) }
}

/// What New thread remembers across launches, as the web's `machine-choice.ts` does per browser:
/// the machine a thread was started on last and, per machine, its last project and model.
struct NewThreadMemory: Codable, Equatable, Sendable {
    struct Choice: Codable, Equatable, Sendable {
        var projectId: String?
        var provider: String?
        var model: String?
        var account: String?
    }
    var machine: String?
    var choices: [String: Choice] = [:]

    /// The machine New thread opens on: the one remembered while it can start a thread and is
    /// reachable; else the first paired that can, reachable ones first; else the first listed.
    /// Names only break ties between machines listed in the same place.
    static func machine(_ options: [NewThreadMachineOption], remembered: String?) -> String? {
        if let remembered, let option = options.first(where: { $0.hostId == remembered }), option.canOperate, option.reachable {
            return remembered
        }
        let ranked = options.enumerated().sorted { a, b in
            let left = (a.element.canOperate ? 0 : 1, a.element.reachable ? 0 : 1, a.offset)
            let right = (b.element.canOperate ? 0 : 1, b.element.reachable ? 0 : 1, b.offset)
            if left != right { return left < right }
            return a.element.name.localizedStandardCompare(b.element.name) == .orderedAscending
        }
        return ranked.first?.element.hostId
    }

    /// `draft` moved to `machine`: that machine's last project and model come back, and what
    /// belonged to the other machine (effort, speed, access, base) goes.
    func open(_ draft: NewThreadDraft, on machine: String) -> NewThreadDraft {
        var next = draft
        let choice = choices[machine]
        next.machineId = machine
        next.projectId = choice?.projectId
        next.provider = choice?.provider
        next.model = choice?.provider == nil ? nil : choice?.model
        next.account = choice?.provider == nil ? nil : choice?.account
        next.effort = nil; next.speed = nil; next.access = nil; next.base = nil
        return next
    }

    /// Keep what `draft` chose on its machine; an unchosen field keeps the last one.
    mutating func record(_ draft: NewThreadDraft) {
        guard let machine = draft.machineId else { return }
        var choice = choices[machine] ?? Choice()
        if let project = draft.projectId { choice.projectId = project }
        if let provider = draft.provider {
            choice.provider = provider; choice.model = draft.model; choice.account = draft.account
        }
        choices[machine] = choice
    }
}

/// `NewThreadMemory` in UserDefaults; it names machines and projects by id and holds no secret.
struct NewThreadMemoryStore {
    let defaults: UserDefaults
    var key = "ace.newThread.memory"
    static func standard() -> NewThreadMemoryStore { NewThreadMemoryStore(defaults: .standard) }

    func load() -> NewThreadMemory {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(NewThreadMemory.self, from: $0) } ?? NewThreadMemory()
    }
    func update(_ change: (inout NewThreadMemory) -> Void) {
        var memory = load()
        change(&memory)
        if let data = try? JSONEncoder().encode(memory) { defaults.set(data, forKey: key) }
    }
    /// A thread is being started on, or New thread was moved to, `draft`'s machine.
    func remember(_ draft: NewThreadDraft) {
        update { memory in
            memory.machine = draft.machineId ?? memory.machine
            memory.record(draft)
        }
    }
    /// `draft` changed its project or model without moving machine.
    func record(_ draft: NewThreadDraft) { update { $0.record(draft) } }
}

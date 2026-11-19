import Foundation

/// `profile.combine` (`bridge/profile-report.ts`): a year of the person's agent work over every
/// machine, added up and worded by `@ace/ui-core` as the web's profile does, for Swift to draw.
struct ProfileReport: Decodable, Sendable, Equatable {
    struct Figure: Decodable, Sendable, Hashable { let label: String; let value: String }
    struct Month: Decodable, Sendable, Hashable { let label: String; let week: Int }
    struct Provider: Decodable, Sendable, Hashable { let name: String; let percent: Int }
    /// "All 3 machines", "2 of 3 machines · Studio is offline"; nil for one counted machine.
    let coverage: String?
    let span: String
    let empty: Bool
    let highlights: [Figure]
    /// One column per week, Sunday first: 0 for no work, 1–4 by quartile, -1 outside the year.
    let weeks: [[Int]]
    let months: [Month]
    let providers: [Provider]
    let insights: [Figure]
}

/// The profile's reads across machines: each machine answers its own year (`profile.part`) on
/// its own runtime, and one runtime adds them up (`profile.combine`). Swift only routes, as the
/// Usage screen's reads do; a machine that is offline or fails stays named in the answer.
@MainActor struct ProfileReads {
    let machines: [MachineSession]
    let name: (String) -> String

    private static func online(_ machine: MachineSession) -> Bool { machine.client.connection == "ready" }
    private var combiner: ClientModel? { (machines.first(where: Self.online) ?? machines.first)?.client }

    /// Every machine's year; `draw` gets the combined answer as each machine arrives. Answers why
    /// nothing could be read, or nil.
    func report(draw: (ProfileReport) -> Void) async -> String? {
        var parts: [String: ServiceValue] = [:]
        var reach: [String: String] = [:]
        let read: [String: Any] = ["type": "profile.part"]
        for machine in machines {
            reach[machine.hostId] = Self.online(machine) ? "loading" : "offline"
            // What the last visit read draws at once, while each machine reads again behind it.
            if Self.online(machine), let kept = machine.client.kept(read, as: ServiceValue.self) {
                parts[machine.hostId] = kept
                reach[machine.hostId] = "counted"
            }
        }
        if !parts.isEmpty, let reply = await combine(parts, reach) { draw(reply) }
        var problem: String?
        await withTaskGroup(of: (String, ServiceValue?, String?).self) { group in
            for machine in machines where Self.online(machine) {
                let client: ClientModel = machine.client
                let id: String = machine.hostId
                group.addTask { await Self.part(client, id: id) }
            }
            for await (id, part, error) in group {
                if Task.isCancelled { return }
                if let part { parts[id] = part; reach[id] = "counted" }
                else { parts[id] = nil; reach[id] = "failed"; problem = problem ?? error }
                if let reply = await combine(parts, reach) { draw(reply) }
            }
        }
        if !machines.contains(where: Self.online), let reply = await combine(parts, reach) { draw(reply) }
        return parts.isEmpty ? problem : nil
    }

    private static func part(_ client: ClientModel, id: String) async -> (String, ServiceValue?, String?) {
        do { return (id, try await client.read(["type": "profile.part"], as: ServiceValue.self), nil) }
        catch { return (id, nil, error.localizedDescription) }
    }

    private func combine(_ parts: [String: ServiceValue], _ reach: [String: String]) async -> ProfileReport? {
        let entries: [[String: Any]] = machines.map { machine in
            let named = name(machine.hostId)
            var entry: [String: Any] = ["id": machine.hostId, "name": String((named.isEmpty ? machine.hostId : named).prefix(128)),
                                        "reach": reach[machine.hostId] ?? "loading"]
            if let part = parts[machine.hostId] { entry["part"] = part.json }
            return entry
        }
        return try? await combiner?.service(["type": "profile.combine", "machines": entries], as: ProfileReport.self)
    }
}

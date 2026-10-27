import Foundation

/// The Usage screen's reads across machines. Each machine answers its own part on its own
/// runtime (`usage.part`, `usage.accounts`); this gathers them and hands them to one runtime to
/// add up (`usage.combine`, `usage.combineLimits` in the bridge). Swift only routes: every sum,
/// merge and word comes from shared code. A machine that is offline or fails stays in the list,
/// so the combined answer names it instead of dropping it.
@MainActor struct UsageMachineReads {
    let machines: [MachineSession]
    let name: (String) -> String

    private struct Gathered {
        var answers: [String: ServiceValue] = [:]
        var reach: [String: String] = [:]
        var settled: Bool { !reach.values.contains("loading") }
        var counted: Bool { reach.values.contains("counted") }
        mutating func counted(_ id: String, _ answer: ServiceValue) { answers[id] = answer; reach[id] = "counted" }
        mutating func failed(_ id: String) { answers[id] = nil; reach[id] = "failed" }
    }

    private static func online(_ machine: MachineSession) -> Bool { machine.client.connection == "ready" }
    /// Combining needs no network, but a ready runtime answers soonest.
    private var combiner: ClientModel? { (machines.first(where: Self.online) ?? machines.first)?.client }

    private static func partRequest(days: Int, provider: String?, from: String?, to: String?, fresh: Bool) -> [String: Any] {
        var read: [String: Any] = ["type": "usage.part", "days": days]
        if let provider { read["provider"] = provider }
        if let from, let to { read["from"] = from; read["to"] = to }
        if fresh { read["fresh"] = true }
        return read
    }

    /// Cost and Tokens over every machine. `draw` gets each combined answer as machines arrive;
    /// answers with why nothing could be read, or nil.
    func report(days: Int, provider: String?, fresh: Bool, draw: (UsageReportReply) -> Void) async -> String? {
        var state = Gathered()
        for machine in machines { state.reach[machine.hostId] = Self.online(machine) ? "loading" : "offline" }
        let base = Self.partRequest(days: days, provider: provider, from: nil, to: nil, fresh: false)
        // Kept parts first, so the screen draws at once and reads again behind them.
        if let lead = machines.first(where: Self.online), let kept = lead.client.kept(base, as: ServiceValue.self) {
            state.counted(lead.hostId, kept)
            let spanned = Self.partRequest(days: days, provider: provider, from: kept["from"]?.string, to: kept["to"]?.string, fresh: false)
            for machine in machines where machine.hostId != lead.hostId && Self.online(machine) {
                if let part = machine.client.kept(spanned, as: ServiceValue.self) { state.counted(machine.hostId, part) }
            }
            if let reply = await combine(days: days, state) { draw(reply) }
        }
        // The first machine that answers chooses the days; the rest count the same ones.
        var problem: String?
        var lead: (id: String, from: String?, to: String?)?
        for machine in machines where Self.online(machine) {
            do {
                let part = try await machine.client.read(Self.partRequest(days: days, provider: provider, from: nil, to: nil, fresh: fresh),
                                                         as: ServiceValue.self)
                state.counted(machine.hostId, part)
                lead = (machine.hostId, part["from"]?.string, part["to"]?.string)
                break
            } catch {
                if Task.isCancelled { return nil }
                state.failed(machine.hostId)
                problem = problem ?? error.localizedDescription
            }
        }
        guard let lead else {
            if state.settled, let reply = await combine(days: days, state) { draw(reply) }
            return problem
        }
        let rest = machines.filter { $0.hostId != lead.id && state.reach[$0.hostId] != "failed" && Self.online($0) }
        if !rest.isEmpty || state.settled, let reply = await combine(days: days, state) { draw(reply) }
        let from = lead.from, to = lead.to
        await withTaskGroup(of: (String, ServiceValue?).self) { group in
            for machine in rest {
                let client: ClientModel = machine.client
                let id: String = machine.hostId
                group.addTask {
                    await Self.part(client, id: id, days: days, provider: provider, from: from, to: to, fresh: fresh)
                }
            }
            for await (id, part) in group {
                if Task.isCancelled { return }
                if let part { state.counted(id, part) } else { state.failed(id) }
                if let reply = await combine(days: days, state) { draw(reply) }
            }
        }
        return state.counted ? nil : problem
    }

    /// Limits over every machine; `refresh` first asks each machine's CLIs for current limits.
    func limits(fresh: Bool, refresh: Bool, draw: (UsageLimitsReply) -> Void) async -> String? {
        var state = Gathered()
        let base: [String: Any] = ["type": "usage.accounts"]
        for machine in machines {
            state.reach[machine.hostId] = Self.online(machine) ? "loading" : "offline"
            if !refresh, Self.online(machine), let kept = machine.client.kept(base, as: ServiceValue.self) {
                state.counted(machine.hostId, kept)
            }
        }
        if state.counted || state.settled, let reply = await combineLimits(state) { draw(reply) }
        var problem: String?
        await withTaskGroup(of: (String, ServiceValue?, String?).self) { group in
            for machine in machines where Self.online(machine) {
                let client: ClientModel = machine.client
                let id: String = machine.hostId
                group.addTask {
                    await Self.accounts(client, id: id, fresh: fresh, refresh: refresh)
                }
            }
            for await (id, answer, error) in group {
                if Task.isCancelled { return }
                if let answer { state.counted(id, answer) } else { state.failed(id); problem = problem ?? error }
                if let reply = await combineLimits(state) { draw(reply) }
            }
        }
        return state.counted ? nil : problem
    }

    private static func part(_ client: ClientModel, id: String, days: Int, provider: String?, from: String?, to: String?,
                             fresh: Bool) async -> (String, ServiceValue?) {
        let read = partRequest(days: days, provider: provider, from: from, to: to, fresh: fresh)
        return (id, try? await client.read(read, as: ServiceValue.self))
    }

    private static func accounts(_ client: ClientModel, id: String, fresh: Bool, refresh: Bool) async -> (String, ServiceValue?, String?) {
        do {
            let answer = refresh
                ? try await client.service(["type": "usage.refreshLimits"], as: ServiceValue.self, timeout: .seconds(45))
                : try await client.read(fresh ? ["type": "usage.accounts", "fresh": true] : ["type": "usage.accounts"], as: ServiceValue.self)
            return (id, answer, nil)
        } catch { return (id, nil, error.localizedDescription) }
    }

    private func entries(_ state: Gathered, field: String, value: (ServiceValue) -> Any?) -> [[String: Any]] {
        machines.map { machine in
            let named = name(machine.hostId)
            var entry: [String: Any] = ["id": machine.hostId, "name": String((named.isEmpty ? machine.hostId : named).prefix(128)),
                                        "reach": state.reach[machine.hostId] ?? "loading"]
            if let answer = state.answers[machine.hostId], let json = value(answer) { entry[field] = json }
            return entry
        }
    }

    private func combine(days: Int, _ state: Gathered) async -> UsageReportReply? {
        let payload: [String: Any] = ["type": "usage.combine", "days": days, "machines": entries(state, field: "part") { $0.json }]
        return try? await combiner?.service(payload, as: UsageReportReply.self)
    }

    private func combineLimits(_ state: Gathered) async -> UsageLimitsReply? {
        let payload: [String: Any] = ["type": "usage.combineLimits", "machines": entries(state, field: "accounts") { $0["accounts"]?.json }]
        return try? await combiner?.service(payload, as: UsageLimitsReply.self)
    }
}

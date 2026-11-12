import Foundation

/// The Fleet map's reads and fixes across machines. Each machine answers its own part on its own
/// runtime (`fleetMap.part`); this adds what the phone knows about each connection and hands
/// everything to one runtime to put together (`fleetMap.combine` in `bridge/fleet-map.ts`).
/// Swift only routes: the nodes, words and fixes come from shared code. A machine that's away
/// stays in the list, so the map says it isn't answering instead of dropping it.
@MainActor struct FleetMapReads {
    let inbox: MachineInbox
    let machines: MachinesModel?

    private static let partRequest: [String: Any] = ["type": "fleetMap.part"]
    private struct Saved: Decodable { let ok: Bool }
    private struct Answer: Decodable { let ok: Bool; var message: String? }

    private var live: [MachineSession] { inbox.sessions.filter { $0.client.connection == "ready" } }
    /// Combining needs no network, but a ready runtime answers soonest.
    private var combiner: ClientModel? { (live.first ?? inbox.sessions.first)?.client }

    /// Every machine the Machines list shows, in its order.
    private var hostIds: [String] { MachinesView.listed(inbox: inbox, machines: machines) }

    /// The map, from kept parts at once and again as each machine answers. Answers why a machine
    /// couldn't be read, or nil.
    func load(draw: (FleetMapReply) -> Void) async -> String? {
        var parts: [String: ServiceValue] = [:]
        for session in live {
            if let kept = session.client.kept(Self.partRequest, as: ServiceValue.self) { parts[session.hostId] = kept }
        }
        if let reply = await combine(parts) { draw(reply) }
        var problem: String?
        await withTaskGroup(of: (String, ServiceValue?, String?).self) { group in
            for session in live {
                let client: ClientModel = session.client
                let id: String = session.hostId
                group.addTask { await Self.part(client, id: id) }
            }
            for await (id, part, error) in group {
                if Task.isCancelled { return }
                if let part { parts[id] = part } else { problem = problem ?? error }
                if let reply = await combine(parts) { draw(reply) }
            }
        }
        return problem
    }

    private static func part(_ client: ClientModel, id: String) async -> (String, ServiceValue?, String?) {
        do { return (id, try await client.read(partRequest, as: ServiceValue.self), nil) }
        catch { return (id, nil, error.localizedDescription) }
    }

    /// What the phone knows about one machine's connection, with its part when it answered.
    private func fact(_ hostId: String, part: ServiceValue?) -> [String: Any] {
        let facts = MachineFacts(inbox: inbox, machines: machines, hostId: hostId)
        let entry = machines?.entry(hostId)
        let client = inbox.client(hostId)
        var fact: [String: Any] = [
            "id": hostId,
            "name": String((facts.name.isEmpty ? hostId : facts.name).prefix(128)),
            "connection": client?.connection ?? "offline",
            "off": facts.off,
            "needsPairing": facts.needsPairing,
            "askingCode": client?.machineCodeAsk != nil,
            "onAccountRelay": entry?.accountHostId != nil && machines?.plans[hostId]?.current == .relay,
            "working": facts.working,
        ]
        if let code = client?.problem?.code { fact["problem"] = String(code.prefix(64)) }
        if let entry { fact["target"] = ["kind": entry.target.kind, "url": entry.target.url] }
        if let icon = entry?.icon?.kind { fact["icon"] = icon }
        if let part { fact["part"] = part.json }
        return fact
    }

    private func combine(_ parts: [String: ServiceValue]) async -> FleetMapReply? {
        let payload: [String: Any] = ["type": "fleetMap.combine", "machines": hostIds.prefix(32).map { fact($0, part: parts[$0]) }]
        return try? await combiner?.service(payload, as: FleetMapReply.self)
    }

    /// Runs a fix or a reach action that changes a machine. Answers why it couldn't, or nil.
    func run(_ action: FleetMapReply.Action) async -> String? {
        switch action.kind {
        case "retry":
            if let machine = action.machine { inbox.client(machine)?.retry() }
            return nil
        case "setting":
            guard let machine = action.machine, let key = action.key, let value = action.value else { return nil }
            return await set(key, value, on: machine)
        case "revoke":
            for target in action.devices ?? [] {
                guard let client = inbox.client(target.machine) else { return "Connect to \(inbox.name(target.machine)) to remove the device there." }
                let request: [String: Any] = ["op": "revoke", "deviceId": target.deviceId]
                let answer = try? await client.service(["type": "native.fleet", "machine": inbox.name(target.machine), "request": request], as: Answer.self)
                if answer?.ok != true { return answer?.message ?? "Couldn't remove it on \(inbox.name(target.machine))." }
            }
            return nil
        default:
            return nil
        }
    }

    /// Writes one remote access setting on a machine, as Fleet rules does.
    func set(_ key: String, _ value: Bool, on machine: String) async -> String? {
        guard let client = inbox.client(machine) else { return "Connect to \(inbox.name(machine)) to change it." }
        let saved = try? await client.service(["type": "settings.set", "key": key, "value": value, "layer": ["kind": "global"]], as: Saved.self)
        return saved?.ok == true ? nil : "Couldn't change it on \(inbox.name(machine)). Check that you have full access there."
    }
}

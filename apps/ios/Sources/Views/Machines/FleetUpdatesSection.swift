import SwiftUI

/// `fleet.updates` (`bridge/fleet-updates.ts`): the fleet's update headline, each machine's line,
/// who the run asks now and Update all now's question, decided by `@ace/ui-core` as the web's
/// Settings › Fleet decides them.
struct FleetUpdatesReply: Decodable, Sendable, Equatable {
    struct Headline: Decodable, Sendable, Equatable { let title: String; let note: String?; let actions: [String] }
    struct Line: Decodable, Sendable, Equatable { let id: String; let words: String; let tone: String; let action: String? }
    struct Send: Decodable, Sendable, Equatable { let id: String; let version: String; let mode: String; let agents: Int }
    struct Confirm: Decodable, Sendable, Equatable { let title: String; let body: String; let confirm: String }
    let headline: Headline?
    let lines: [Line]
    let sends: [Send]
    let confirm: Confirm
    let run: ServiceValue?
}

private struct FleetRunReply: Decodable, Sendable { let run: ServiceValue? }
private struct StartReply: Decodable, Sendable { let ok: Bool; let words: String? }

/// The fleet's updates on the phone: every machine's status read on its own runtime, the run the
/// person started kept on this phone (it outlives the app closing), and Update all. Swift only
/// routes; every decision and word is shared code's.
@MainActor @Observable final class FleetUpdates {
    static let runKey = "ace.fleet.updateRun"
    private(set) var reply: FleetUpdatesReply?
    private var statuses: [String: ServiceValue] = [:]
    private var asking = Set<String>()
    /// Changes to the kept run, one at a time: each answer applies to the latest run, never to
    /// a copy another answer has already moved on.
    private var mutation: Task<Void, Never>?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    /// A run is under way: the section reads again until it ends.
    var running: Bool { run != nil }

    private var run: ServiceValue? {
        get { defaults.data(forKey: Self.runKey).flatMap { try? JSONDecoder().decode(ServiceValue.self, from: $0) } }
        set {
            if let newValue, let data = try? JSONEncoder().encode(newValue) { defaults.set(data, forKey: Self.runKey) }
            else { defaults.removeObject(forKey: Self.runKey) }
        }
    }

    private static func online(_ session: MachineSession) -> Bool { session.client.connection == "ready" }

    private func facts(_ inbox: MachineInbox) -> [[String: Any]] {
        inbox.sessions.map { session in
            let named = inbox.name(session.hostId)
            var fact: [String: Any] = [
                "id": session.hostId, "name": String((named.isEmpty ? session.hostId : named).prefix(128)),
                "online": Self.online(session),
                "access": session.client.canAdmin.map { $0 ? "admin" : "read" } ?? "unknown",
            ]
            if let status = statuses[session.hostId] { fact["update"] = status["update"]?.json ?? NSNull() }
            return fact
        }
    }

    /// Read every machine's status, then decide; asks whoever the run says is due.
    func refresh(_ inbox: MachineInbox) async {
        await withTaskGroup(of: (String, ServiceValue?).self) { group in
            for session in inbox.sessions where Self.online(session) {
                let client: ClientModel = session.client
                let id: String = session.hostId
                group.addTask { (id, try? await client.read(["type": "machineUpdate.status"], as: ServiceValue.self)) }
            }
            for await (id, status) in group { if let status { statuses[id] = status } }
        }
        await decide(inbox)
    }

    /// Update all: idle waits for each machine's agents to finish; now stops them, after the
    /// person confirmed `reply.confirm`.
    func updateAll(_ inbox: MachineInbox, mode: String) async {
        let request: [String: Any] = ["type": "fleet.run", "op": "start", "mode": mode, "machines": facts(inbox), "now": Self.now()]
        guard let started = try? await combiner(inbox)?.service(request, as: FleetRunReply.self) else { return }
        await mutate { [self] in run = started.run }
        await decide(inbox)
    }

    private func decide(_ inbox: MachineInbox) async {
        var request: [String: Any] = ["type": "fleet.updates", "machines": facts(inbox), "now": Self.now()]
        let sent = run
        if let sent { request["run"] = sent.json }
        guard let next = try? await combiner(inbox)?.service(request, as: FleetUpdatesReply.self) else { return }
        reply = next
        // The run sent no longer reads: it's gone. Only that one, never one started meanwhile.
        if next.run == nil, let sent { await mutate { [self] in if run == sent { run = nil } } }
        for send in next.sends where !asking.contains(send.id) {
            guard let session = inbox.sessions.first(where: { $0.hostId == send.id }) else { continue }
            asking.insert(send.id)
            Task { await ask(session, send, inbox: inbox) }
        }
    }

    private func ask(_ session: MachineSession, _ send: FleetUpdatesReply.Send, inbox: MachineInbox) async {
        defer { asking.remove(send.id) }
        let name = inbox.name(session.hostId)
        let start: [String: Any] = ["type": "machineUpdate.start", "name": String((name.isEmpty ? session.hostId : name).prefix(128)),
                                    "mode": send.mode, "version": send.version, "agents": send.agents]
        let answer = try? await session.client.service(start, as: StartReply.self, timeout: .seconds(20))
        let words = String((answer?.words ?? "\(name) didn't start the update.").prefix(400))
        await mutate { [self] in
            // The run as it stands now, after any other machine's answer.
            guard let current = run else { return }
            var change: [String: Any] = ["type": "fleet.run", "run": current.json, "id": send.id]
            if answer?.ok == true { change["op"] = "sent"; change["now"] = Self.now() }
            else { change["op"] = "failed"; change["words"] = words }
            if let moved = try? await combiner(inbox)?.service(change, as: FleetRunReply.self) { run = moved.run }
        }
        await refresh(inbox)
    }

    private func mutate(_ change: @escaping @MainActor () async -> Void) async {
        let previous = mutation
        let next = Task { @MainActor in
            await previous?.value
            await change()
        }
        mutation = next
        await next.value
    }

    /// Deciding needs no network, but a ready runtime answers soonest.
    private func combiner(_ inbox: MachineInbox) -> ClientModel? {
        (inbox.sessions.first(where: Self.online) ?? inbox.sessions.first)?.client
    }
    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }
}

/// Settings › Machines' Updates: the fleet's headline with Update all, and each machine's line.
/// Hidden while there's nothing to say.
struct FleetUpdatesSection: View {
    let inbox: MachineInbox
    @State private var updates = FleetUpdates()
    @State private var confirming = false

    var body: some View {
        Group {
            if let reply = updates.reply, reply.headline != nil || !reply.lines.isEmpty {
                Section {
                    if let headline = reply.headline {
                        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                            Text(headline.title).font(AceDesign.Typeface.body)
                            if let note = headline.note {
                                Text(note).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                            }
                        }
                        .accessibilityIdentifier("fleet.updates.headline")
                        if headline.actions.contains("all") {
                            Button("Update all") { Task { await updates.updateAll(inbox, mode: "idle") } }
                                .buttonStyle(.textAction(.prominent))
                                .accessibilityIdentifier("fleet.updates.all")
                        }
                        if headline.actions.contains("all-now") {
                            Button("Update all now…") { confirming = true }
                                .buttonStyle(.textAction())
                                .accessibilityIdentifier("fleet.updates.allNow")
                        }
                    }
                    ForEach(reply.lines, id: \.id) { line in
                        LabeledContent(inbox.name(line.id)) {
                            Text(line.words).foregroundStyle(line.tone == "warn" ? AceTheme.Status.failed : AceDesign.Ink.muted)
                        }
                    }
                } header: { InsetHeader("Updates") }
                .insetRowBackground()
                .confirmationDialog(reply.confirm.title, isPresented: $confirming, titleVisibility: .visible) {
                    Button(reply.confirm.confirm, role: .destructive) { Task { await updates.updateAll(inbox, mode: "now") } }
                } message: { Text(reply.confirm.body) }
            }
        }
        // Again when any machine connects or drops, and every few seconds while a run is under
        // way, so a machine back online is asked and progress shows as it happens.
        .task(id: inbox.sessions.map { "\($0.hostId):\($0.client.connection)" }) {
            await updates.refresh(inbox)
            while updates.running, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await updates.refresh(inbox)
            }
        }
    }
}

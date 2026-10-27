import SwiftUI

private struct FleetRulesReply: Decodable {
    struct Option: Decodable, Hashable { let value: String; let label: String; let note: String? }
    struct Confirm: Decodable { let title: String; let body: String; let action: String }
    struct Rule: Decodable, Identifiable { let key: String; let title: String; let note: String?; let control: String; let options: [Option]?; let confirm: Confirm?; var id: String { key } }
    let rules: [Rule]
}
private struct RuleSettingReply: Decodable {
    struct Entry: Decodable { let key: String; let value: ServiceValue }
    struct Diagnostic: Decodable { let message: String }
    let ok: Bool
    let entries: [Entry]
    var diagnostics: [Diagnostic] = []
}

/// Rules set on every connected machine at once, as the web's Fleet › Access: remote access,
/// the network machines are reached over, and what agents from other machines may do. A rule
/// the machines disagree on says "Differs"; a machine's own settings can still set it apart.
struct FleetRulesView: View {
    let inbox: MachineInbox
    @State private var rules: [FleetRulesReply.Rule] = []
    /// Per rule, each connected machine's value.
    @State private var values: [String: [String: ServiceValue]] = [:]
    @State private var problem: String?
    @State private var saving: String?
    @State private var pending: (rule: FleetRulesReply.Rule, value: ServiceValue)?
    @State private var saved = 0
    /// Every machine's values have been read once: until then the rows keep their shape, never a wrong value.
    @State private var loaded = false

    private var connected: [MachineSession] { inbox.sessions.filter { $0.client.connection == "ready" && $0.client.canOperate } }

    var body: some View {
        Form {
            Section {
                if loaded {
                    ForEach(rules) { rule in row(rule) }
                } else {
                    ForEach(["Remote access", "Reached over", "Pairing links open app.acehq.dev", "Agents from other machines", "Agents can move projects and threads", "Bring ignored files"], id: \.self) { title in
                        LabeledContent(title) { Text("Off") }.redacted(reason: .placeholder)
                    }
                    .accessibilityHidden(true)
                }
            } footer: {
                Text(connected.count > 1 ? "Set on \(connected.count) connected machines. A machine's own settings can set it apart." : "Set on every connected machine.")
            }
            .insetRowBackground()
            if let problem { Section { ServiceProblem(message: problem) }.insetRowBackground() }
        }
        .insetGroupedList()
        .smoothChange(loaded)
        .smoothChange(problem)
        .sensoryFeedback(.success, trigger: saved)
        .navigationTitle("Fleet rules").navigationBarTitleDisplayMode(.inline)
        .task(id: connected.map(\.hostId)) { await read() }
        .refreshable { await read() }
        .confirmationDialog(pending?.rule.confirm?.title ?? "", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            Button(pending?.rule.confirm?.action ?? "Change", role: .destructive) {
                if let pending { Task { await write(pending.rule, pending.value) } }
            }
        } message: { Text(pending?.rule.confirm?.body ?? "") }
    }

    @ViewBuilder private func row(_ rule: FleetRulesReply.Rule) -> some View {
        let current = merged(rule.key)
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            switch rule.control {
            case "toggle":
                Toggle(rule.title, isOn: Binding(get: { if case .bool(let on)? = current { on } else { false } }, set: { on in
                    if !on, rule.confirm != nil { pending = (rule, .bool(false)) } else { Task { await write(rule, .bool(on)) } }
                }))
                .toggleStyle(.systemSwitch)
                if current == nil, values[rule.key]?.isEmpty == false { differs }
            default:
                Picker(rule.title, selection: Binding(get: { if case .string(let text)? = current { text } else { "" } }, set: { value in
                    if rule.confirm != nil { pending = (rule, .string(value)) } else { Task { await write(rule, .string(value)) } }
                })) {
                    if current == nil { Text("Differs").tag("") }
                    ForEach(rule.options ?? [], id: \.self) { Text($0.label).tag($0.value) }
                }
            }
            let chosen = rule.options?.first { option in if case .string(let text)? = current { text == option.value } else { false } }
            if let note = chosen?.note ?? rule.note {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .disabled(saving != nil || connected.isEmpty)
        .accessibilityIdentifier("fleetRule.\(rule.key)")
    }
    private var differs: some View {
        Text("Differs between machines").aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
    }
    /// The machines' shared value, or nil while they differ or none answered. "local" is remote
    /// access off; the transport shows the network it would open on.
    private func merged(_ key: String) -> ServiceValue? {
        let all = (values[key] ?? [:]).values.map { value -> ServiceValue in
            if key == "remote.transport", case .string("local") = value { return .string("lan") }
            return value
        }
        guard let first = all.first, all.allSatisfy({ $0 == first }) else { return nil }
        return first
    }

    private func read() async {
        guard let first = connected.first else { return }
        do {
            rules = try await first.client.service(["type": "native.fleet", "machine": inbox.name(first.hostId), "request": ["op": "rules"]], as: FleetRulesReply.self).rules
            var next: [String: [String: ServiceValue]] = [:]
            let keys = rules.map(\.key)
            // Every machine's every rule is asked at once; each answer lands as it comes.
            let reads = connected.flatMap { session in
                keys.map { key in
                    (key, session.hostId, Task { try? await session.client.service(["type": "settings.get", "key": key, "scope": [:] as [String: Any]], as: RuleSettingReply.self) })
                }
            }
            for (key, host, read) in reads {
                if let value = await read.value?.entries.first(where: { $0.key == key })?.value { next[key, default: [:]][host] = value }
            }
            values = next
            loaded = true
            problem = nil
        } catch { problem = error.localizedDescription }
    }

    private func write(_ rule: FleetRulesReply.Rule, _ value: ServiceValue) async {
        saving = rule.key
        defer { saving = nil }
        guard let scalar = try? JSONSerialization.jsonObject(with: JSONEncoder().encode(value), options: [.fragmentsAllowed]) else { return }
        var failed: [String] = []
        for session in connected {
            let reply = try? await session.client.service(["type": "settings.set", "key": rule.key, "value": scalar, "layer": ["kind": "global"]], as: RuleSettingReply.self)
            if reply?.ok == true, let saved = reply?.entries.first(where: { $0.key == rule.key })?.value { values[rule.key, default: [:]][session.hostId] = saved }
            else { failed.append(inbox.name(session.hostId)) }
        }
        if failed.isEmpty { saved += 1 }
        problem = failed.isEmpty ? nil : "Couldn't change \(rule.title.lowercased()) on \(failed.joined(separator: ", ")). Check that you have full access there."
    }
}

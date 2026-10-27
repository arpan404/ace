import SwiftUI

/// Which machines a settings change goes to while Settings is open: the machine whose page is
/// showing, or every paired machine. Each paired machine is its own runtime, so "all machines"
/// sends the same change to each machine's bridge, which checks and words it for that machine.
@MainActor @Observable final class SettingsScope {
    struct Machine: Identifiable { let id: String; let name: String; let client: ClientModel }
    var all = false
    @ObservationIgnored private let inbox: MachineInbox
    init(inbox: MachineInbox) { self.inbox = inbox }

    var machines: [Machine] { inbox.sessions.map { Machine(id: $0.hostId, name: inbox.name($0.hostId), client: $0.client) } }
    var several: Bool { inbox.sessions.count > 1 }
    func name(_ client: ClientModel) -> String { machines.first { $0.client === client }?.name ?? "This machine" }

    /// The bridge's answer for each page's machine (`settingsScopePlan` in `@ace/ui-core`): where
    /// a change goes and the line that says so. A view-only machine is never a target.
    struct Plan: Decodable, Sendable, Equatable { let send: [String]; let footer: String }
    private(set) var plans: [String: Plan] = [:]

    /// What the plan is worked out from; it's asked again whenever this changes.
    func planKey(for client: ClientModel) -> String {
        "\(all)|" + machines.map { "\($0.id):\($0.client.connection == "ready"):\($0.client.canOperate)" }.joined(separator: ",")
    }
    func refreshPlan(for client: ClientModel) async {
        guard let current = machines.first(where: { $0.client === client }) else { return }
        let payload: [String: Any] = [
            "type": "settings.scope", "all": all, "current": current.id,
            "machines": machines.map { ["id": $0.id, "name": $0.name, "connected": $0.client.connection == "ready", "canOperate": $0.client.canOperate] as [String: Any] },
        ]
        if let plan = try? await client.service(payload, as: Plan.self) { plans[current.id] = plan }
    }

    /// Where a change made on `client`'s page goes. With one machine paired it's that machine;
    /// with several, the bridge's plan decides, and until it answers only the page's own machine,
    /// when this phone may change it, takes the change.
    func targets(from client: ClientModel) -> [Machine] {
        let own = machines.filter { $0.client === client && $0.client.canOperate }
        guard several, let current = own.first ?? machines.first(where: { $0.client === client }) else { return own }
        guard let plan = plans[current.id] else { return own }
        return machines.filter { plan.send.contains($0.id) }
    }
}

private struct SettingsScopeKey: EnvironmentKey { static let defaultValue: SettingsScope? = nil }
extension EnvironmentValues {
    var settingsScope: SettingsScope? {
        get { self[SettingsScopeKey.self] }
        set { self[SettingsScopeKey.self] = newValue }
    }
}

/// The top of every machine settings page when several machines are paired: where changes go,
/// and which machines they reach.
struct SettingsScopeSection: View {
    @Bindable var scope: SettingsScope
    let client: ClientModel
    var body: some View {
        let footer = scope.plans[scope.machines.first { $0.client === client }?.id ?? ""]?.footer
        Section {
            Picker("Changes go to", selection: $scope.all) {
                Text("This machine").tag(false)
                Text("All machines").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("settings.scope")
        } header: {
            InsetHeader("Changes go to")
        } footer: {
            // The line is reserved while the plan is first read, so nothing moves when it arrives.
            Text(footer ?? " ").contentTransition(.opacity)
                .animation(.smooth, value: footer)
                .accessibilityIdentifier("settings.scope.targets")
        }
        .insetRowBackground()
        .sensoryFeedback(.selection, trigger: scope.all)
        .task(id: scope.planKey(for: client)) { await scope.refreshPlan(for: client) }
    }
}

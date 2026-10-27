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

    /// Where a change made on `client`'s page goes: that machine alone, or every machine that
    /// can take it now. Machines that can't are named, so the person knows they kept their value.
    func targets(from client: ClientModel) -> (send: [Machine], skipped: [Machine]) {
        guard all, several else { return (machines.filter { $0.client === client }, []) }
        let reachable = machines.filter { $0.client.connection == "ready" && $0.client.canOperate }
        let skipped = machines.filter { machine in !reachable.contains { $0.id == machine.id } }
        return (reachable, skipped)
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
        let (send, skipped) = scope.targets(from: client)
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
            Text(footer(send: send, skipped: skipped)).contentTransition(.opacity)
                .accessibilityIdentifier("settings.scope.targets")
        }
        .insetRowBackground()
        .sensoryFeedback(.selection, trigger: scope.all)
    }
    private func footer(send: [SettingsScope.Machine], skipped: [SettingsScope.Machine]) -> String {
        let names = ListFormatter.localizedString(byJoining: send.map(\.name))
        guard scope.all else { return "Only \(names)." }
        let reached = send.isEmpty ? "No machine is connected." : "\(names)."
        guard !skipped.isEmpty else { return reached }
        let away = ListFormatter.localizedString(byJoining: skipped.map(\.name))
        return "\(reached) \(away) \(skipped.count == 1 ? "isn't" : "aren't") connected and keep\(skipped.count == 1 ? "s its" : " their") own."
    }
}

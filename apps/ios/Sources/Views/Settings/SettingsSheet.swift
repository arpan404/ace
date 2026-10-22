import SwiftUI

/// Every screen Settings pushes inside its own stack.
enum SettingsRoute: Hashable {
    case machines, machine(String), pair
    case notifications, lock, appearance
    case archive, profiles, thread(machine: String, id: String)
    case tool(SettingsTool, machine: String)
    case licences
}

/// Settings, opened from the inbox: connections (machines, notifications, Face ID), the
/// interface, threads (archive, profiles), each machine's tools, and the app itself. Everything
/// pushes inside this sheet's own stack.
struct SettingsSheet: View {
    let inbox: MachineInbox
    var machines: MachinesModel?
    var lock: AppLock?
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?
    @Environment(\.dismiss) private var dismiss
    @AppStorage("ace.appearance") private var appearance = "system"
    @AppStorage("ace.keyboard.returnSends") private var returnSends = false
    @State private var path: [SettingsRoute]
    @State private var toolsMachine = ""
    /// The machine whose archive window is open while the archive or one of its threads shows.
    @State private var following: String?

    init(inbox: MachineInbox, machines: MachinesModel? = nil, lock: AppLock? = nil, start: [SettingsRoute] = []) {
        self.inbox = inbox
        self.machines = machines
        self.lock = lock
        _path = State(initialValue: start)
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    link(.machines, "Machines", .laptop, value: inbox.sessions.count.formatted(), id: "settings.machines")
                    if notifications != nil {
                        link(.notifications, "Notifications", .bell, value: notifications?.delivering == true ? "On" : "Off", id: "settings.notifications")
                    }
                    if let lock { link(.lock, "Face ID", .scanSmiley, value: lock.enabled ? "On" : "Off", id: "settings.lock") }
                } header: { SettingsHeader("Connections") }
                .settingsRow()
                Section {
                    link(.appearance, "Appearance", .palette, value: PhoneAppearance.label(appearance), id: "settings.appearance")
                    Toggle(isOn: $returnSends) { SettingsLinkLabel(title: "Send with Return", icon: .keyboard) }
                        .accessibilityIdentifier("settings.returnSends")
                } header: { SettingsHeader("This phone") }
                .settingsRow()
                Section {
                    link(.archive, "Archived", .archive, id: "settings.archive")
                    link(.profiles, "Task profiles", .identificationCard, id: "settings.profiles")
                } header: { SettingsHeader("Threads") }
                .settingsRow()
                SettingsTools(inbox: inbox, machine: $toolsMachine)
                Section {
                    SettingsLinkLabel(title: "About", icon: .info, value: "\(app.version) (\(app.build))")
                        .accessibilityElement(children: .combine)
                    link(.licences, "Licences", .fileText, id: "settings.licences")
                    ShareLink(item: report.json, preview: SharePreview("ace diagnostics")) {
                        SettingsLinkLabel(title: "Send diagnostics", icon: .export)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.diagnostics")
                } header: { SettingsHeader("App") }
                .settingsRow()
            }
            .settingsList()
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { AceIcon(.x, size: 18) }
                        .accessibilityLabel("Close").accessibilityIdentifier("settings.close")
                }
            }
            .navigationDestination(for: SettingsRoute.self) { route in destination(route) }
        }
        .tint(AceTheme.Colours.foreground)
        .toggleStyle(.systemSwitch)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onChange(of: path) { old, new in navigated(from: old, to: new) }
        .onDisappear { closeMachineViews() }
    }

    private func link(_ route: SettingsRoute, _ title: String, _ icon: AceIcon.Name, value: String? = nil, id: String) -> some View {
        NavigationLink(value: route) { SettingsLinkLabel(title: title, icon: icon, value: value) }
            .accessibilityIdentifier(id)
    }

    @ViewBuilder private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .machines: MachinesView(inbox: inbox, machines: machines)
        case .machine(let hostId): MachineDetailView(inbox: inbox, machines: machines, hostId: hostId)
        case .pair:
            if let machines { PairingView(machines: machines) { path.removeAll { $0 == .pair } } }
        case .notifications:
            if let notifications { NotificationSettingsView(notifications: notifications, inbox: inbox) }
        case .lock:
            if let lock { AppLockView(lock: lock) }
        case .appearance: AppearanceView()
        case .archive:
            ArchiveView(inbox: inbox, following: $following) { machine, id in
                inbox.client(machine)?.open(id)
                path.append(.thread(machine: machine, id: id))
            }
        case .profiles: TaskProfilesView(store: TaskProfileStore(defaults: .standard))
        case .thread(let machine, let id):
            if let client = inbox.client(machine), let thread = client.thread, thread.id == id {
                ThreadView(model: client, thread: thread) { child in
                    client.open(child)
                    path.append(.thread(machine: machine, id: child))
                }
            }
        case .tool(let tool, let machine):
            if let client = inbox.client(machine) { tool.destination(client) }
        case .licences: LicencesView()
        }
    }

    /// Back from an archived thread reopens its parent, or leaves the thread when none is left;
    /// leaving the archive closes its window.
    private func navigated(from old: [SettingsRoute], to new: [SettingsRoute]) {
        guard new.count < old.count else { return }
        if case .thread(let machine, _) = old.last {
            if case .thread(let parentMachine, let parent) = new.last { inbox.client(parentMachine)?.open(parent) }
            else { inbox.client(machine)?.back() }
        }
        if !new.contains(.archive), let following {
            inbox.client(following)?.closeArchive()
            self.following = nil
        }
    }
    private func closeMachineViews() {
        if let following { inbox.client(following)?.closeArchive(); self.following = nil }
        for session in inbox.sessions {
            session.client.action(["type": "native.devices.close"])
            session.client.action(["type": "native.screen.close"])
        }
    }

    private var app: DiagnosticsReport.App { .current }
    private var report: DiagnosticsReport {
        DiagnosticsReport.collect(app: app, inbox: inbox, entries: machines?.machines ?? [], notifications: notifications, lock: lock, now: Date())
    }
}

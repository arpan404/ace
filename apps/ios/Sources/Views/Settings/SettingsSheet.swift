import SwiftUI

/// Every screen Settings pushes inside its own stack.
enum SettingsRoute: Hashable {
    case machines, machine(String), pair
    case notifications, lock, appearance, keyboard
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
    @State private var path: [SettingsRoute]
    @State private var toolsMachine = ""
    /// The machine whose archive window is open while the archive or one of its threads shows.
    @State private var following: String?
    /// Where machine settings changes go while Settings is open (`SettingsScope`).
    @State private var scope: SettingsScope

    init(inbox: MachineInbox, machines: MachinesModel? = nil, lock: AppLock? = nil, start: [SettingsRoute] = []) {
        self.inbox = inbox
        self.machines = machines
        self.lock = lock
        _path = State(initialValue: start)
        _scope = State(initialValue: SettingsScope(inbox: inbox))
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    link(.machines, "Machines", "laptopcomputer", value: inbox.sessions.count.formatted(), id: "settings.machines")
                    if notifications != nil {
                        link(.notifications, "Notifications", "bell", value: notifications?.delivering == true ? "On" : "Off", id: "settings.notifications")
                    }
                    if let lock { link(.lock, "Face ID", "lock", value: lock.enabled ? "On" : "Off", id: "settings.lock") }
                } header: { InsetHeader("Connections") }
                .insetRowBackground()
                Section {
                    link(.appearance, "Appearance", "paintpalette", value: PhoneAppearance.label(appearance), id: "settings.appearance")
                    link(.keyboard, "Keyboard", "keyboard", id: "settings.keyboard")
                } header: { InsetHeader("Interface") }
                .insetRowBackground()
                Section {
                    link(.archive, "Archived", "archivebox", id: "settings.archive")
                    link(.profiles, "Task profiles", "person.text.rectangle", id: "settings.profiles")
                } header: { InsetHeader("Threads") }
                .insetRowBackground()
                SettingsTools(inbox: inbox, machine: $toolsMachine)
                Section {
                    InsetRow("About", systemImage: "info.circle", value: "\(app.version) (\(app.build))")
                        .accessibilityElement(children: .combine)
                    link(.licences, "Licences", "doc.text", id: "settings.licences")
                    ShareLink(item: report.json, preview: SharePreview("ace diagnostics")) {
                        InsetRow("Send diagnostics", systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("settings.diagnostics")
                } header: { InsetHeader("App") }
                .insetRowBackground()
            }
            .insetGroupedList()
            .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close").accessibilityIdentifier("settings.close")
                }
            }
            .navigationDestination(for: SettingsRoute.self) { route in destination(route) }
        }
        .environment(\.settingsScope, scope)
        .escapeCloses { dismiss() }
        .tint(AceTheme.Colours.foreground)
        .toggleStyle(.systemSwitch)
        .presentationDetents([.large]).presentationDragIndicator(.visible)
        .onChange(of: path) { old, new in navigated(from: old, to: new) }
        .onDisappear { closeMachineViews() }
    }

    private func link(_ route: SettingsRoute, _ title: String, _ symbol: String, value: String? = nil, id: String) -> some View {
        NavigationLink(value: route) { InsetRow(title, systemImage: symbol, value: value) }
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
        case .keyboard: KeyboardSettingsView()
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

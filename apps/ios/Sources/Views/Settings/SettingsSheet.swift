import SwiftUI

/// Every screen Settings pushes inside its own stack.
enum SettingsRoute: Hashable {
    /// More's own places: Settings' list, and Pull requests with its pages.
    case settings, pulls, forge(ForgeRoute)
    case machines, machine(String), pair
    case notifications, lock, appearance, keyboard
    case archive, profiles, cache, thread(machine: String, id: String)
    case tool(SettingsTool, machine: String)
    case automation(machine: String, id: String)
    case licences
}

/// What More's Pull requests asks of the inbox: a thread or New thread opens there, after More
/// closes.
struct MorePlaces {
    let openThread: (InboxKey) -> Void
    let startThread: () -> Void
}

/// More, opened from the inbox header: the app's secondary places as a grouped list. Pull
/// requests and Settings first, then each machine's tools. Settings is the connections
/// (machines, notifications, Face ID), the interface, threads (archive, profiles) and the app
/// itself. Everything pushes inside this sheet's own stack.
struct SettingsSheet: View {
    let inbox: MachineInbox
    var places: MorePlaces? = nil
    var machines: MachinesModel?
    var lock: AppLock?
    @Environment(NotificationCoordinator.self) private var notifications: NotificationCoordinator?
    @Environment(\.dismiss) private var dismiss
    @AppStorage("ace.appearance") private var appearance = "system"
    @State private var path: [SettingsRoute]
    @State private var toolsMachine = ""
    @State private var automationUndo = AutomationUndo()
    /// The machine whose archive window is open while the archive or one of its threads shows.
    @State private var following: String?
    /// Where machine settings changes go while Settings is open (`SettingsScope`).
    @State private var scope: SettingsScope

    @State private var forgeMachine = ""
    @State private var forgeProject = ""
    @State private var forgeKind = ForgeKind.pulls
    @State private var forgeQuery = ""

    init(inbox: MachineInbox, places: MorePlaces? = nil, machines: MachinesModel? = nil, lock: AppLock? = nil, start: [SettingsRoute] = []) {
        self.inbox = inbox
        self.places = places
        self.machines = machines
        self.lock = lock
        _path = State(initialValue: start)
        _scope = State(initialValue: SettingsScope(inbox: inbox))
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                Section {
                    if places != nil { link(.pulls, "Pull requests", "arrow.triangle.pull", id: "more.pulls") }
                    link(.settings, "Settings", "gearshape", id: "more.settings")
                }
                .insetRowBackground()
                SettingsTools(inbox: inbox, machine: $toolsMachine)
            }
            .insetGroupedList()
            .navigationTitle("More").navigationBarTitleDisplayMode(.inline)
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

    /// Settings' own list, one step into More.
    private var settingsList: some View {
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
                    link(.cache, "Cached chats", "internaldrive", id: "settings.cache")
                } header: { InsetHeader("Threads") }
                .insetRowBackground()
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
    }

    /// Pull requests, Issues and Notifications (the forge's lists), each row pushing its page on
    /// More's stack. A thread or New thread opens on the inbox once More closes.
    private var pullRequests: some View {
        ForgeHome(inbox: inbox, machine: $forgeMachine, project: $forgeProject, query: forgeQuery, kind: $forgeKind,
                  actions: ForgeTabActions(open: { path.append(.forge($0)) }, openThread: { leave(to: $0) },
                                           startThread: { start() }),
                  openMachines: { path.append(.machines) })
            .searchable(text: $forgeQuery, prompt: Text(forgeKind == .pulls ? "Search pull requests" : forgeKind == .issues ? "Search issues" : "Search notifications"))
            .navigationTitle("Pull requests").navigationBarTitleDisplayMode(.inline)
            .modifier(ProjectDefaultsHook(inbox: inbox))
    }
    private func leave(to key: InboxKey) {
        dismiss()
        places?.openThread(key)
    }
    private func start() {
        dismiss()
        places?.startThread()
    }

    private func link(_ route: SettingsRoute, _ title: String, _ symbol: String, value: String? = nil, id: String) -> some View {
        NavigationLink(value: route) { InsetRow(title, systemImage: symbol, value: value) }
            .accessibilityIdentifier(id)
    }

    @ViewBuilder private func destination(_ route: SettingsRoute) -> some View {
        switch route {
        case .settings: settingsList
        case .pulls: pullRequests
        case .forge(let page):
            ForgePage(inbox: inbox, route: page, open: { path.append(.forge($0)) }, openThread: { leave(to: $0) },
                      startThread: inbox.canStartThreads ? { start() } : nil)
        case .machines: MachinesView(inbox: inbox, machines: machines)
        case .machine(let hostId): MachineDetailView(inbox: inbox, machines: machines, hostId: hostId)
        case .pair:
            if let machines { PairingView(machines: machines) { path.removeAll { $0 == .pair } } }
        case .notifications:
            if let notifications { NotificationSettingsView(notifications: notifications, inbox: inbox) }
        case .lock:
            if let lock { AppLockView(lock: lock) }
        case .appearance: AppearanceView(inbox: inbox)
        case .keyboard: KeyboardSettingsView()
        case .archive:
            ArchiveView(inbox: inbox, following: $following) { machine, id in
                inbox.client(machine)?.open(id)
                path.append(.thread(machine: machine, id: id))
            }
        case .profiles: TaskProfilesView(store: TaskProfileStore(defaults: .standard))
        case .cache: CachedChatsView(inbox: inbox)
        case .thread(let machine, let id):
            if let client = inbox.client(machine), let thread = client.thread, thread.id == id {
                ThreadView(model: client, thread: thread) { child in
                    client.open(child)
                    path.append(.thread(machine: machine, id: child))
                }
            }
        case .tool(let tool, let machine):
            if let client = inbox.client(machine) { tool.destination(client, inbox: inbox, machine: machine).modifier(automationLinks(client, machine)) }
        case .automation(let machine, let id):
            if let client = inbox.client(machine) { AutomationDetailView(model: client, id: id).id(id).modifier(automationLinks(client, machine)) }
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
    /// An automation opens on Settings' own stack, and a run's thread opens on top of it.
    private func automationLinks(_ client: ClientModel, _ machine: String) -> AutomationLinks {
        AutomationLinks(
            open: { id in path.append(.automation(machine: machine, id: id)) },
            replace: { id in
                if case .automation = path.last { path.removeLast() }
                path.append(.automation(machine: machine, id: id))
            },
            thread: { id in
                client.open(id)
                path.append(.thread(machine: machine, id: id))
            },
            undo: automationUndo)
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

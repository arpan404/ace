import SwiftUI

/// Computer use on a machine: the apps agents or people use, agent-held first with who has each
/// in the web's words, setup problems as one sentence with one action, and Share an app window.
/// An app opens its live screen. `threadId` puts a shared app with that thread.
struct RemoteScreenView: View {
    let model: ClientModel
    var threadId: String? = nil
    @State private var screen = RemoteScreen()
    @State private var opened: ScreenSessionInfo?
    @State private var sharing = false
    @State private var turningOff = false

    var body: some View {
        List {
            if model.connection != "ready" {
                InboxConnectionBanner(connection: model.connection, retry: model.retry).listRowSeparator(.hidden)
            }
            content
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceTheme.Colours.background)
        .threadTitle("Computer use", subtitle: subtitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { menu }
            if model.canOperate, screen.status?.enabled == true {
                ToolbarItem(placement: .bottomBar) {
                    Button(screen.dialogPicks ? "Share a window or screen" : "Share an app window") { sharing = true }.disabled(screen.busy).accessibilityIdentifier("screen.share")
                }
            }
        }
        .task(id: model.connection) {
            if model.connection == "ready" { await screen.refresh(model); await screen.targets(model) } else { screen.disconnected() }
        }
        .refreshable { await screen.refresh(model) }
        .navigationDestination(item: $opened) { session in
            RemoteScreenSessionView(model: model, screen: screen, sessionId: session.id)
        }
        .sheet(isPresented: $sharing) {
            ScreenTargetPicker(model: model, screen: screen, threadId: threadId, chooseThere: chooseThere) { id in
                sharing = false
                opened = screen.session(id)
            }
        }
        .confirmationDialog("Stop agents using apps on this machine?", isPresented: $turningOff, titleVisibility: .visible) {
            Button("Turn off", role: .destructive) { Task { _ = await screen.perform(model, ["op": "enable", "enabled": false]) } }
        } message: {
            Text("Every app session stops, for every thread.")
        }
        .onDisappear { if opened == nil { screen.disconnected(); model.action(["type": "native.screen.close"]) } }
    }

    /// The machine's own dialog picks: the picker closes and the list shows the wait.
    private func chooseThere() {
        sharing = false
        Task { if let id = await screen.startChoice(model, threadId: threadId) { opened = screen.session(id) } }
    }

    private var subtitle: String {
        guard screen.status?.enabled == true else { return "" }
        let live = screen.sessions.filter { $0.lifecycle == "live" }.count
        return live == 0 ? "No apps live" : "\(live) live"
    }

    @ViewBuilder private var content: some View {
        if let status = screen.status {
            if !status.enabled {
                DeviceNote(sentence: "Agents can't use apps on this machine.", action: model.canOperate ? "Turn on" : nil) {
                    Task { _ = await screen.perform(model, ["op": "enable", "enabled": true]) }
                }
            } else {
                if screen.sessions.isEmpty {
                    Text("No apps in use.").aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.mutedForeground).listRowSeparator(.hidden)
                }
                ForEach(screen.sessions) { session in
                    Button { opened = session } label: { SessionRow(session: session) }
                        .buttonStyle(.plain)
                        .listRowBackground(AceTheme.Colours.background)
                        .listRowSeparatorTint(AceTheme.Colours.separator)
                        .listSectionSeparator(.hidden, edges: .top)
                        .accessibilityIdentifier("screen.row")
                }
            }
            permission("Screen Recording", allowed: status.permissions.screenRecording, key: "screenRecording")
            permission("Accessibility", allowed: status.permissions.accessibility, key: "accessibility")
        } else if screen.problem == nil {
            ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden).accessibilityLabel("Loading computer use")
        }
        if let problem = screen.problem {
            DeviceNote(sentence: problem, action: "Try again") { Task { await screen.refresh(model) } }
        }
        NavigationLink { RemoteSettingsView(model: model, category: .computer) } label: {
            Text("App access and device preferences").aceFont(AceTheme.Typography.body, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
        }
        .listRowBackground(AceTheme.Colours.background)
        .listRowSeparator(.hidden)
    }

    @ViewBuilder private func permission(_ name: String, allowed: Bool, key: String) -> some View {
        if !allowed {
            DeviceNote(sentence: "macOS hasn't given ace \(name) permission.", action: model.canOperate ? "Grant access" : nil) {
                Task { _ = await screen.perform(model, ["op": "permissions.request", "permission": key]); await screen.refresh(model) }
            }
        }
    }

    private var menu: some View {
        Menu {
            Button("Refresh", ace: .arrowClockwise) { Task { await screen.refresh(model) } }
            if model.canOperate, screen.status?.enabled == true {
                Button("Turn off computer use…", ace: .prohibit, role: .destructive) { turningOff = true }
            }
        } label: { Label("Computer use options", ace: .dotsThree) }
    }
}

/// One app: its name, then who has it and how, in one line.
private struct SessionRow: View {
    let session: ScreenSessionInfo
    var body: some View {
        HStack(spacing: AceTheme.Spacing.md) {
            AceIcon(.appWindow, size: 21)
                .foregroundStyle(AceTheme.Colours.foreground).frame(width: 28).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(session.app).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                Text([session.status, session.mode].joined(separator: " · "))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(session.error.isEmpty ? AceTheme.Colours.mutedForeground : AceTheme.StatusText.failed).lineLimit(1)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            AceIcon(.caretRight, size: 14, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.decoration).accessibilityHidden(true)
        }
        .frame(minHeight: 60)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct ScreenTargetPicker: View {
    let model: ClientModel
    let screen: RemoteScreen
    let threadId: String?
    let chooseThere: () -> Void
    let selected: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var bundleId = ""
    @State private var query = ""
    @State private var searching = false
    /// One share at a time: a second tap while the first starts would share the app twice.
    @State private var starting = false
    var body: some View {
        NavigationStack {
            List {
                if screen.dialogPicks {
                    Section {
                        Button(action: chooseThere) {
                            InsetRow(systemImage: "rectangle.on.rectangle", title: "Share a window or screen…",
                                     subtitle: "Chosen in the sharing dialog on that computer. Only you can control a shared screen.") { EmptyView() }
                        }
                        .buttonStyle(.plain).insetRowBackground().accessibilityIdentifier("screen.chooser")
                    }
                } else {
                Section {
                    TextField("App bundle ID", text: $bundleId).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onSubmit { share(.init(kind: "app", bundleId: bundleId, windowId: nil, displayId: nil, bundleIds: nil)) }
                        .insetRowBackground()
                } header: { InsetHeader("Open an app") }
                Section {
                    ForEach(screen.windows.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.bundleId.localizedCaseInsensitiveContains(query) }) { window in
                        Button { share(window.target) } label: {
                            InsetRow(icon: .appWindow, title: window.title.isEmpty ? window.bundleId : window.title, subtitle: window.bundleId) { EmptyView() }
                        }
                        .buttonStyle(.plain).insetRowBackground()
                    }
                } header: { InsetHeader("Open windows") }
                }
                if let problem = screen.problem { Text(problem).foregroundStyle(AceTheme.Colours.mutedForeground).listRowBackground(Color.clear) }
            }
            .insetGroupedList()
            .disabled(screen.busy || starting)
            .searchable(text: $query, isPresented: $searching, prompt: "Search app windows")
            .navigationTitle("Share an app window").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close", ace: .x) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Share", ace: .check) { share(.init(kind: "app", bundleId: bundleId, windowId: nil, displayId: nil, bundleIds: nil)) }
                        .disabled(bundleId.isEmpty)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .task { await screen.targets(model) }
    }
    private func share(_ target: RemoteScreenTarget) {
        guard !starting, target.kind != "app" || !(target.bundleId ?? "").isEmpty else { return }
        starting = true
        Task {
            defer { starting = false }
            guard let id = await screen.start(model, target: target, threadId: threadId) else { return }
            // An active search holds the sheet open; end it so the sheet closes onto the app.
            searching = false
            selected(id)
        }
    }
}

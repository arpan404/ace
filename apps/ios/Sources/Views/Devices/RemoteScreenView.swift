import SwiftUI

/// Computer use on a machine, grouped as the web's Settings › Computer use: Access (agents may
/// use apps, locked use, Use my Chrome, the apps they can't use), the live sessions agent-held
/// first, and every permission the screen helper needs. A read that fails says so with Try
/// again. An app opens its live screen; `threadId` puts a shared app with that thread.
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
                    .listRowBackground(Color.clear)
            }
            readState
            access
            if let status = screen.status {
                if status.enabled || !screen.sessions.isEmpty { liveSessions }
                Section {
                    ForEach(ScreenPermissionRow.rows(status.permissions)) { row in permissionRow(row) }
                } header: { InsetHeader("Permissions") }
            }
        }
        .insetGroupedList()
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
        .onAppear { model.followComputerAccess(mac: !screen.dialogPicks) }
        .onDisappear { model.unfollowComputerAccess() }
        .onChange(of: screen.dialogPicks) { _, dialog in model.computerAccessMac(!dialog) }
        .animation(.default, value: model.computerAccess.state)
        .animation(.default, value: screen.page)
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

    private func retry() { Task { await screen.refresh(model) } }

    private var subtitle: String {
        guard screen.status?.enabled == true else { return "" }
        let live = screen.sessions.filter { $0.lifecycle == "live" }.count
        return live == 0 ? "No apps live" : "\(live) live"
    }

    /// The read under way, or what stopped it. A later read that fails sits over the rows the
    /// last one found.
    @ViewBuilder private var readState: some View {
        switch screen.page {
        case .reading:
            SkeletonRows(count: 2, label: "Loading computer use", retry: retry)
                .listRowInsets(EdgeInsets()).listRowBackground(Color.clear).listRowSeparator(.hidden)
        case .failed(let message):
            ProblemRow("Couldn't read computer use on this machine", detail: message, id: "screen.problem",
                       disabled: screen.reading, retry: retry)
        case .shown:
            if let problem = screen.readProblem ?? screen.problem {
                ProblemRow(problem, id: "screen.problem", disabled: screen.reading || screen.busy, retry: retry)
            }
        }
    }

    @ViewBuilder private var access: some View {
        Section {
            if let status = screen.status {
                InsetRow(icon: .aceComputerUse, title: "Let agents use apps",
                         subtitle: status.enabled ? "Agents can see and use this machine's apps" : "Agents can't use apps here") {
                    Toggle("Let agents use apps", isOn: Binding(get: { status.enabled }, set: { on in
                        if on { Task { _ = await screen.perform(model, ["op": "enable", "enabled": true]) } } else { turningOff = true }
                    }))
                    .labelsHidden()
                    .disabled(!model.canOperate || screen.busy)
                    .accessibilityIdentifier("screen.enabled")
                }
                .insetRowBackground()
            }
            if let locked = model.computerAccess.state?.locked {
                LockedUseRow(model: model, locked: locked, busy: model.computerAccess.state?.busy != nil)
                    .insetRowBackground()
                    .transition(.opacity)
            }
            NavigationLink { UseMyChromeView(model: model) } label: {
                InsetRow(icon: .globe, title: "Use my Chrome") { InsetValue(text: chromeValue) }
            }
            .insetRowBackground()
            .accessibilityIdentifier("computer.chrome")
            NavigationLink { RemoteSettingsView(model: model, category: .computer) } label: {
                InsetRow(icon: .prohibit, title: "App access", subtitle: "Apps agents can't use") { EmptyView() }
            }
            .insetRowBackground()
            .accessibilityIdentifier("computer.appAccess")
        } header: { InsetHeader("Access") }
        if let error = model.computerAccess.state?.error {
            ProblemRow(error, id: "computer.problem")
        }
    }

    private var chromeValue: String? {
        guard model.mayAdminister else { return "Owner only" }
        guard let chrome = model.computerAccess.state?.chrome else { return nil }
        if !chrome.installed { return "Not set up" }
        return chrome.connections.isEmpty ? "Installed" : "\(chrome.connections.count) connected"
    }

    private var liveSessions: some View {
        Section {
            if screen.sessions.isEmpty {
                Text("No apps in use.").aceFont(AceDesign.TextRole.rowTitle)
                    .foregroundStyle(AceDesign.Ink.muted).insetRowBackground()
            }
            ForEach(screen.sessions) { session in
                Button { opened = session } label: { SessionRow(session: session) }
                    .buttonStyle(.plain)
                    .insetRowBackground()
                    .accessibilityIdentifier("screen.row")
            }
        } header: { InsetHeader("Live sessions") }
    }

    private func permissionRow(_ row: ScreenPermissionRow) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.title).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                Text(row.detail).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                if let action = row.action, let key = row.permission, model.canOperate {
                    Button(action) {
                        Task { _ = await screen.perform(model, ["op": "permissions.request", "permission": key]); await screen.refresh(model) }
                    }
                    // Borderless, so only the button asks and the rest of the row stays still.
                    .buttonStyle(.borderless).foregroundStyle(AceDesign.Ink.action)
                    .disabled(screen.busy)
                    .accessibilityIdentifier("screen.permission.\(row.id).request")
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            StateLabel(status: StatusDisplay(label: row.status, token: row.ready ? "done" : "neutral"))
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .insetRowBackground()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("screen.permission.\(row.id)")
    }

    /// ⋯ as every bar draws it: the plain glyph in the body ink, sized by iOS (the thread's ⋯).
    private var menu: some View {
        Menu {
            Button("Refresh", ace: .arrowClockwise, action: retry)
        } label: {
            Image(bar: .dotsThree, weight: .bold).foregroundStyle(AceTheme.Colours.foreground)
        }
        .barGlyph()
        .accessibilityLabel("Computer use options")
        .accessibilityIdentifier("screen.menu")
    }
}

/// One app: its name, then who has it and how, in one line.
private struct SessionRow: View {
    let session: ScreenSessionInfo
    var body: some View {
        HStack(spacing: AceDesign.Space.row) {
            AceIcon(.appWindow, size: AceDesign.Size.icon, relativeTo: .subheadline)
                .foregroundStyle(AceDesign.Ink.primary).frame(width: AceDesign.Size.icon + AceDesign.Space.related).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(session.app).font(AceDesign.Typeface.body)
                    .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                Text([session.status, session.mode].joined(separator: " · "))
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(session.error.isEmpty ? AceDesign.Ink.muted : AceTheme.StatusText.failed).lineLimit(1)
            }
            Spacer(minLength: AceDesign.Space.related)
            AceIcon(.caretRight, size: AceDesign.Size.icon, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.faint).accessibilityHidden(true)
        }
        .frame(minHeight: AceDesign.Size.rowThread)
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
                            InsetRow(icon: .monitor, title: "Share a window or screen…",
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
                if let problem = screen.problem { Text(problem).foregroundStyle(AceDesign.Ink.muted).listRowBackground(Color.clear) }
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

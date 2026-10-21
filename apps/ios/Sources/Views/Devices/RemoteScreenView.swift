import SwiftUI

struct RemoteScreenView: View {
    let model: ClientModel
    var threadId: String? = nil
    @State private var screen = RemoteScreen()
    @State private var path: [String] = []
    @State private var sharing = false
    var body: some View {
        List {
            if model.connection != "ready" { InboxConnectionBanner(connection: model.connection, retry: model.retry) }
            Section("Access") {
                Toggle("Let agents use apps", isOn: Binding(get: { screen.status?.enabled == true }, set: { enabled in
                    Task { _ = await screen.perform(model, ["op": "enable", "enabled": enabled]) }
                })).disabled(screen.status == nil || screen.busy || !model.canOperate || model.connection != "ready")
                NavigationLink("App access and device preferences") { RemoteSettingsView(model: model, category: .computer) }
            }
            if let permissions = screen.status?.permissions {
                Section("macOS permissions") {
                    permission("Screen Recording", allowed: permissions.screenRecording, key: "screenRecording")
                    permission("Accessibility", allowed: permissions.accessibility, key: "accessibility")
                    Button("Check again") { Task { _ = await screen.perform(model, ["op": "permissions"]); await screen.refresh(model) } }.disabled(screen.busy)
                }
            }
            Section("Live apps") {
                ForEach(screen.states.filter { $0.lifecycle != "stopped" }) { state in
                    Button { path.append(state.id) } label: {
                        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                            Text(state.title).foregroundStyle(AceTheme.Colours.foreground)
                            Text("\(state.lifecycle.capitalized) · \(state.controller.capitalized)").foregroundStyle(AceTheme.Colours.mutedForeground)
                            if let error = state.error { Text(error).foregroundStyle(AceTheme.StatusText.failed) }
                        }
                    }
                }
                if screen.states.allSatisfy({ $0.lifecycle == "stopped" }) { Text("No live apps.").foregroundStyle(AceTheme.Colours.mutedForeground) }
                if model.canOperate {
                    Button("Share an app window", systemImage: "macwindow.badge.plus") { sharing = true }
                        .disabled(screen.status?.enabled != true || screen.busy)
                }
            }
            if screen.status == nil && screen.problem == nil { ProgressView("Reading computer access…") }
            ServiceProblem(message: screen.problem)
            if screen.problem != nil { Button("Retry") { Task { await screen.refresh(model) } } }
        }
        .navigationTitle("Computer use").navigationBarTitleDisplayMode(.inline)
        .task(id: model.connection) { if model.connection == "ready" { await screen.refresh(model) } else { screen.disconnected() } }
        .refreshable { await screen.refresh(model) }
        .navigationDestination(isPresented: Binding(get: { !path.isEmpty }, set: { if !$0 { path = [] } })) {
            if let id = path.last { RemoteScreenSessionView(model: model, screen: screen, sessionId: id) }
        }
        .sheet(isPresented: $sharing) {
            ScreenTargetPicker(model: model, screen: screen, threadId: threadId) { id in sharing = false; path = [id] }
        }
        .onDisappear {
            if path.isEmpty { screen.disconnected(); model.action(["type": "native.screen.close"]) }
        }
    }
    private func permission(_ name: String, allowed: Bool, key: String) -> some View {
        LabeledContent(name) {
            if allowed { Text("Granted").foregroundStyle(AceTheme.Colours.mutedForeground) }
            else {
                Button("Grant access") { Task { _ = await screen.perform(model, ["op": "permissions.request", "permission": key]) } }
                    .disabled(screen.busy || !model.canOperate || model.connection != "ready").accessibilityLabel("Grant \(name) access")
            }
        }
    }
}

private struct ScreenTargetPicker: View {
    let model: ClientModel
    let screen: RemoteScreen
    let threadId: String?
    let selected: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var bundleId = ""
    @State private var query = ""
    var body: some View {
        NavigationStack {
            List {
                Section("Open app") {
                    TextField("App bundle ID", text: $bundleId).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("Share app") { share(.init(kind: "app", bundleId: bundleId, windowId: nil, displayId: nil, bundleIds: nil)) }.disabled(bundleId.isEmpty)
                }
                Section("Open windows") {
                    ForEach(screen.windows.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) || $0.bundleId.localizedCaseInsensitiveContains(query) }) { window in
                        Button { share(window.target) } label: {
                            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                                Text(window.title.isEmpty ? window.bundleId : window.title)
                                Text(window.bundleId).foregroundStyle(AceTheme.Colours.mutedForeground)
                            }
                        }
                    }
                }
                ServiceProblem(message: screen.problem)
            }
            .disabled(screen.busy)
            .searchable(text: $query, prompt: "Search app windows")
            .navigationTitle("Share app").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .task { await screen.targets(model) }
    }
    private func share(_ target: RemoteScreenTarget) {
        Task { if let id = await screen.start(model, target: target, threadId: threadId) { selected(id) } }
    }
}

import SwiftUI

private struct PastSession: Decodable, Identifiable {
    struct Support: Decodable { let status: String; let reason: String? }
    let id: String
    let title: String
    let provider: String
    let messageCount: Int
    let support: Support
}
private struct PastSessionsReply: Decodable {
    struct Cursor: Codable { let lastActivity: Double; let id: String }
    struct Scan: Decodable { let state: String; let error: String? }
    let sessions: [PastSession]
    let next: Cursor?
    let scan: Scan?
}
private struct HistoryImportReply: Decodable { let status: String; let threadId: String?; let reason: String? }

/// A project's past CLI sessions, newest first: tapping a supported one imports it as a thread
/// and opens it.
struct PastSessionsView: View {
    let model: ClientModel
    let project: NativeProject
    @State private var sessions: [PastSession] = []
    @State private var next: PastSessionsReply.Cursor?
    @State private var state = ""
    @State private var query = ""
    @State private var problem: String?
    @State private var importing: String?
    @State private var path: [String] = []
    @State private var loading = false
    private var scanning: Bool { ["scanning", "retrying"].contains(state) }
    var body: some View {
        List {
            if scanning {
                HStack(spacing: AceTheme.Spacing.sm) {
                    AceIcon(.clock, size: 16).foregroundStyle(AceTheme.Colours.faintForeground)
                    Text("Reading CLI history").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                .accessibilityElement(children: .combine)
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if let problem, sessions.isEmpty {
                EmptyState(icon: nil, title: "Couldn't read past sessions", line: problem, failed: true) {
                    Button("Try again") { Task { await read() } }
                }
                .accessibilityIdentifier("service.problem")
                .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if loading && sessions.isEmpty {
                Section {
                    ForEach(0..<4, id: \.self) { index in
                        SettingsSkeletonRow(title: 180, line: 120)
                            .accessibilityElement(children: .ignore).accessibilityLabel("Loading sessions")
                            .accessibilityHidden(index != 0)
                    }
                }
                .settingsRow()
            } else if sessions.isEmpty && !scanning {
                EmptyState(icon: .clockCounterClockwise, title: query.isEmpty ? "No past sessions" : "No sessions match",
                           line: query.isEmpty ? "CLI sessions run in this folder appear here." : nil)
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            if !sessions.isEmpty {
                Section {
                    ForEach(sessions) { session in
                        Button {
                            importing = session.id
                            Task { await open(session) }
                        } label: { row(session) }
                        .buttonStyle(.plain)
                        .disabled(importing != nil || session.support.status != "supported" || !model.canOperate)
                    }
                    if next != nil {
                        Button { Task { await read(more: true) } } label: { SettingsRow(title: "Show more sessions") { EmptyView() } }
                            .buttonStyle(.plain).disabled(loading)
                    }
                    if let problem {
                        ServiceProblem(message: problem)
                        Button { Task { await read() } } label: { SettingsRow(title: "Try again") { EmptyView() } }
                            .buttonStyle(.plain)
                    }
                }
                .settingsRow()
            }
        }
        .settingsList()
        .searchable(text: $query, prompt: "Search past sessions")
        .navigationTitle("Past CLI sessions").navigationBarTitleDisplayMode(.inline)
        .task(id: query) {
            await read()
            while ["scanning", "retrying"].contains(state), !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                await read()
            }
        }
        .refreshable { await read(rescan: true) }
        .navigationDestination(isPresented: Binding(get: { !path.isEmpty }, set: { if !$0 { path = []; model.back() } })) {
            if let thread = model.thread { ThreadView(model: model, thread: thread) { model.open($0) } }
        }
        .onDisappear { Task { _ = try? await model.service(["type": "history.release"], as: ServiceValue.self) } }
    }
    /// The session's title at full ink (muted when it can't be imported), then the agent and
    /// message count, then why it can't be opened when it can't.
    private func row(_ session: PastSession) -> some View {
        let supported = session.support.status == "supported"
        return HStack(spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(session.title.isEmpty ? "Untitled session" : session.title).aceFont(SettingsStyle.label, relativeTo: .body)
                    .foregroundStyle(supported ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground).lineLimit(2)
                Text("\(session.provider.capitalized) · \(session.messageCount) messages").aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                if let reason = session.support.reason {
                    Text(reason).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            if importing == session.id { ProgressView().accessibilityLabel("Opening session") }
        }
        .contentShape(Rectangle())
    }
    private func read(more: Bool = false, rescan: Bool = false) async {
        loading = true; problem = nil
        defer { loading = false }
        do {
            var request: [String: Any] = ["type": "history.list", "cwd": project.path, "search": query, "limit": 50, "rescan": rescan]
            if more, let next { request["before"] = ["lastActivity": next.lastActivity, "id": next.id] }
            let reply = try await model.service(request, as: PastSessionsReply.self)
            guard !Task.isCancelled else { return }
            sessions = (more ? sessions : []) + reply.sessions; next = reply.next; state = reply.scan?.state ?? "ready"
            problem = reply.scan?.error
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func open(_ session: PastSession) async {
        defer { importing = nil }
        do {
            let reply = try await model.service(["type": "history.import", "sourceId": session.id, "workspaceId": project.id], as: HistoryImportReply.self)
            guard reply.status == "imported", let id = reply.threadId else { throw ServiceFailure(message: reply.reason ?? "This session couldn't be imported.") }
            model.open(id); path = [id]
        } catch { problem = error.localizedDescription }
    }
}


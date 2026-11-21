import SwiftUI

private struct PastSession: Decodable, Identifiable {
    struct Support: Decodable { let status: String; let reason: String? }
    let id: String
    let title: String
    let provider: String
    let messageCount: Int
    let support: Support
    /// Whether its provider can resume it, so Continue is offered; absent from older machines.
    let continuation: Support?
    var continuable: Bool { support.status == "supported" && continuation?.status == "supported" }
}
private struct PastSessionsReply: Decodable {
    struct Cursor: Codable { let lastActivity: Double; let id: String }
    struct Scan: Decodable { let state: String; let error: String? }
    let sessions: [PastSession]
    let next: Cursor?
    let scan: Scan?
}
/// `pastSessions.open` (`bridge/past-sessions.ts`): the thread to open, or the shared words for why not.
private struct PastSessionOpened: Decodable { let threadId: String?; let problem: String? }

struct PastSessionsView: View {
    let model: ClientModel
    let project: NativeProject
    @State private var sessions: [PastSession] = []
    @State private var next: PastSessionsReply.Cursor?
    @State private var state = ""
    @State private var query = ""
    @State private var problem: String?
    @State private var importing: String?
    @State private var continuing = false
    @State private var path: [String] = []
    @State private var loading = false
    private var list: some View {
        List {
            if let problem {
                Section { ProblemRow("Couldn't read past sessions.", detail: problem, id: "pastSessions.problem") { Task { await read() } } }
            }
            if ["scanning", "retrying"].contains(state) || loading || importing != nil {
                Section {
                    HStack(spacing: AceDesign.Space.related) {
                        WorkingMark()
                        Text(importing != nil ? (continuing ? "Continuing session…" : "Opening session…") : loading && sessions.isEmpty ? "Loading sessions…" : "Reading CLI history…")
                            .aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                    }
                }
                .listRowBackground(Color.clear)
            }
            if !loading, sessions.isEmpty, problem == nil {
                Section {
                    if query.isEmpty { EmptyState(icon: .clockCounterClockwise, title: "No past CLI sessions in this folder") }
                    else { EmptyState.search(query) }
                }
                .listRowBackground(Color.clear)
            }
            if !sessions.isEmpty {
                Section {
                    ForEach(sessions) { session in row(session) }
                    if next != nil {
                        Button("Show more sessions") { Task { await read(more: true) } }
                            .buttonStyle(.rowAction).disabled(loading)
                    }
                } footer: { Text("Tap a session to bring it into ace as a thread.") }
                .insetRowBackground()
            }
        }
    }

    var body: some View {
        list
        .insetGroupedList()
        .searchBarEdge()
        .smoothChange(sessions.map(\.id))
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
        .navigationDestination(isPresented: opened) { threadPage }
        .onDisappear { Task { _ = try? await model.service(["type": "history.release"], as: ServiceValue.self) } }
    }
    /// The thread an opened session became.
    @ViewBuilder private var threadPage: some View {
        if let thread = model.thread { ThreadView(model: model, thread: thread) { model.open($0) } }
    }

    /// Whether an opened session's thread is showing; going back leaves it.
    private var opened: Binding<Bool> {
        Binding(get: { !path.isEmpty }, set: { if !$0 { path = []; model.back() } })
    }

    /// A session: tapping it imports it as a thread; Continue also resumes it in its CLI.
    private func row(_ session: PastSession) -> some View {
        let title = session.title.isEmpty ? "Untitled session" : session.title
        return HStack(spacing: AceDesign.Space.related) {
            Button { begin(session, action: "import") } label: {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    QuietRowText(title: title, detail: "\(session.provider.capitalized) · \(session.messageCount) messages")
                    if let reason = session.support.reason {
                        Text(reason).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.subtle)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Import \(title)")
            if session.continuable {
                // Imports it, then resumes it in its provider: the next message goes to the CLI's own session.
                Button("Continue") { begin(session, action: "continue") }
                    .buttonStyle(.secondaryAction).controlSize(.small)
                    .accessibilityLabel("Continue \(title)")
            }
        }
        .disabled(importing != nil || session.support.status != "supported" || !model.canOperate)
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
    private func begin(_ session: PastSession, action: String) {
        importing = session.id; continuing = action == "continue"; problem = nil
        Task { await open(session, action: action) }
    }
    /// Import, or import and resume ("continue"), in the bridge; the words for a failure are the web's.
    private func open(_ session: PastSession, action: String) async {
        defer { importing = nil; continuing = false }
        do {
            let reply = try await model.service(["type": "pastSessions.open", "sourceId": session.id, "workspaceId": project.id, "action": action],
                                                as: PastSessionOpened.self)
            guard let id = reply.threadId else { problem = reply.problem; return }
            model.open(id); path = [id]
        } catch { problem = error.localizedDescription }
    }
}

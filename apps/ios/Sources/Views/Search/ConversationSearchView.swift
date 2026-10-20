import SwiftUI

struct ConversationSearchSheet: View {
    let inbox: MachineInbox
    @Environment(\.dismiss) private var dismiss
    @State private var machineId: String
    @State private var path: [String] = []
    init(inbox: MachineInbox) {
        self.inbox = inbox
        _machineId = State(initialValue: inbox.sessions.first?.hostId ?? "")
    }
    private var model: ClientModel? { inbox.client(machineId) }
    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let model {
                    ConversationSearchView(model: model, machine: inbox.sessions.count > 1 ? AnyView(Picker("Machine", selection: $machineId) {
                        ForEach(inbox.sessions) { Text(inbox.name($0.hostId)).tag($0.hostId) }
                    }) : nil) { id in model.open(id); path.append(id) }
                }
            }
            .navigationTitle("Search").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: String.self) { id in
                if let model, let thread = model.thread, thread.id == id {
                    ThreadView(model: model, thread: thread) { model.open($0); path.append($0) }
                }
            }
            .onChange(of: path) { old, new in
                if !old.isEmpty && new.isEmpty { model?.back() }
                else if new.count < old.count, let id = new.last { model?.open(id) }
            }
        }
        .onDisappear { if !path.isEmpty { model?.back() } }
    }
}

struct ConversationSearchView: View {
    let model: ClientModel
    var machine: AnyView? = nil
    var threadId: String? = nil
    let openThread: (String) -> Void
    @State private var search = ConversationSearch()
    @State private var text = ""
    @State private var kind = ""
    private var queryKey: [String] { [model.hostId ?? "", text, kind, threadId ?? "", model.connection] }
    var body: some View {
        List {
            if let machine { machine }
            Picker("Search in", selection: $kind) {
                Text("Everything").tag("")
                Text("Titles").tag("thread")
                Text("Messages").tag("message")
                Text("Tools").tag("tool_call")
                Text("Files").tag("artifact")
                Text("Visualizations").tag("html")
            }
            ForEach(search.hits) { hit in
                if hit.itemId != nil {
                    NavigationLink { SearchHistoryView(model: model, hit: hit, openThread: openThread) } label: { SearchHitLabel(hit: hit) }
                        .accessibilityIdentifier("search.hit.\(hit.id)")
                } else {
                    Button { openThread(hit.threadId) } label: { SearchHitLabel(hit: hit) }
                        .buttonStyle(.plain).accessibilityIdentifier("search.hit.\(hit.id)")
                }
            }
            if let problem = search.problem {
                ServiceProblem(message: problem)
                Button("Retry search") { Task { await run() } }
            } else if search.loading {
                ProgressView().accessibilityLabel("Searching conversations")
            } else if search.loaded && search.hits.isEmpty {
                ContentUnavailableView.search(text: text)
            }
            if search.cursor != nil {
                Button("Show more results") { Task { await search.more(model: model, text: text, kind: kind, threadId: threadId) } }.disabled(search.loading)
            }
        }
        .searchable(text: $text, prompt: "Search messages, tools and files")
        .task(id: queryKey) { await run() }
        .navigationTitle("Search conversation").navigationBarTitleDisplayMode(.inline)
    }
    private func run() async { await search.search(model: model, text: text, kind: kind, threadId: threadId) }
}

private struct SearchHitLabel: View {
    let hit: ConversationHit
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(hit.threadTitle).aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground).lineLimit(2)
            Text(hit.excerpt).aceFont(AceTheme.Typography.body, relativeTo: .body).foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(3)
            Text("\(hit.provider.capitalized) · \(hit.kind.replacingOccurrences(of: "_", with: " "))")
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.subtleForeground)
        }.padding(.vertical, AceTheme.Spacing.xs)
    }
}

private struct HistoryWindowReply: Decodable {
    struct Row: Decodable, Identifiable { let id: String; let seq: Int; let type: String; let role: String; let text: String; let truncated: Bool }
    let target: Int?
    let before: Int?
    let after: Int?
    let rows: [Row]
}

private struct SearchHistoryView: View {
    let model: ClientModel
    let hit: ConversationHit
    let openThread: (String) -> Void
    @State private var window: HistoryWindowReply?
    @State private var problem: String?
    @State private var loading = false
    var body: some View {
        ScrollViewReader { proxy in
            List {
                if let before = window?.before { Button("Earlier messages") { Task { await read(sequence: before) } }.disabled(loading) }
                ForEach(window?.rows ?? []) { row in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                        Text(row.role.isEmpty ? row.type.replacingOccurrences(of: "_", with: " ").capitalized : row.role.capitalized)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                        MarkdownView(text: row.text)
                        if row.truncated { Text("Message shortened").foregroundStyle(AceTheme.Colours.subtleForeground) }
                    }
                    .padding(.vertical, AceTheme.Spacing.sm)
                    .listRowBackground(row.seq == window?.target ? AceTheme.Colours.fill : AceTheme.Colours.background)
                    .id(row.id)
                }
                if let after = window?.after { Button("Later messages") { Task { await read(sequence: after) } }.disabled(loading) }
                if loading { ProgressView().accessibilityLabel("Loading messages") }
                if let problem { ServiceProblem(message: problem); Button("Retry") { Task { await read() } } }
                Button("Open conversation") { openThread(hit.threadId) }.accessibilityIdentifier("search.openThread")
            }
            .listStyle(.plain)
            .navigationTitle(hit.threadTitle).navigationBarTitleDisplayMode(.inline)
            .task { await read(); if let itemId = hit.itemId { proxy.scrollTo(itemId, anchor: .center) } }
        }
    }
    private func read(sequence: Int? = nil) async {
        loading = true; problem = nil
        defer { loading = false }
        do {
            var request: [String: Any] = ["type": "native.history.window", "threadId": hit.threadId]
            if let sequence { request["aroundSeq"] = sequence } else { request["itemId"] = hit.itemId }
            window = try await model.service(request, as: HistoryWindowReply.self)
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

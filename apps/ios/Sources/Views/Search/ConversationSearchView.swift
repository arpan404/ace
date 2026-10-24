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
            .escapeCloses { dismiss() }
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
                // A hit in a message opens its thread there, in the thread's own history window.
                Button {
                    if let itemId = hit.itemId { model.focusOnOpen = ThreadFocus(thread: hit.threadId, item: itemId) }
                    openThread(hit.threadId)
                } label: { SearchHitLabel(hit: hit) }
                    .buttonStyle(.plain).accessibilityIdentifier("search.hit.\(hit.id)")
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

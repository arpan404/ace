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
        ScrollView {
            VStack(alignment: .leading, spacing: AceDesign.Space.group) {
                filters
                results
            }
            .padding(.top, AceDesign.Space.related).padding(.bottom, AceDesign.Space.group)
        }
        .background(AceDesign.Surface.background)
        .searchable(text: $text, prompt: "Search messages, tools and files")
        .task(id: queryKey) { await run() }
        .navigationTitle("Search conversation").navigationBarTitleDisplayMode(.inline)
    }

    /// The machine, when several are paired, and what kind of hit to look for.
    private var filters: some View {
        QuietSection {
            if let machine {
                QuietSectionRow { machine }
            }
            QuietSectionRow {
                Picker("Search in", selection: $kind) {
                    Text("Everything").tag("")
                    Text("Titles").tag("thread")
                    Text("Messages").tag("message")
                    Text("Tools").tag("tool_call")
                    Text("Files").tag("artifact")
                    Text("Visualizations").tag("html")
                }
                .accessibilityIdentifier("conversation.kind")
            }
        }
    }

    @ViewBuilder private var results: some View {
        if let problem = search.problem {
            QuietProblemRow(title: problem, action: "Try again", identifier: "conversation.retry") {
                // A failed "Show more" asks for that page again, keeping the pages already read.
                if search.cursor != nil, !search.hits.isEmpty {
                    Task { await search.more(model: model, text: text, kind: kind, threadId: threadId) }
                } else {
                    Task { await run() }
                }
            }
        } else if search.loading, search.hits.isEmpty {
            SkeletonRows(count: 3, label: "Searching conversations")
        }
        if search.hits.isEmpty, search.problem == nil, search.loaded {
            EmptyState.search(text)
        }
        if !search.hits.isEmpty {
            QuietSection("Results") {
                ForEach(search.hits) { hit in
                    // A hit in a message opens its thread there, in the thread's own history window.
                    Button {
                        if let itemId = hit.itemId { model.focusOnOpen = ThreadFocus(thread: hit.threadId, item: itemId) }
                        openThread(hit.threadId)
                    } label: { SearchHitLabel(hit: hit) }
                        .buttonStyle(.row)
                        .accessibilityIdentifier("search.hit.\(hit.id)")
                }
            }
        }
        if search.cursor != nil {
            QuietSection {
                QuietSectionRow {
                    Button("Show more results") {
                        Task { await search.more(model: model, text: text, kind: kind, threadId: threadId) }
                    }
                    .buttonStyle(.textAction(.prominent))
                    .disabled(search.loading)
                    .accessibilityIdentifier("conversation.more")
                }
            }
        }
    }

    private func run() async { await search.search(model: model, text: text, kind: kind, threadId: threadId) }
}

private struct SearchHitLabel: View {
    let hit: ConversationHit
    var body: some View {
        QuietSectionRow {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                Text(hit.threadTitle).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout)
                    .foregroundStyle(AceDesign.Ink.primary).lineLimit(2)
                Text(hit.excerpt).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(AceDesign.Ink.muted).lineLimit(3)
                Text("\(hit.provider.capitalized) · \(hit.kind.replacingOccurrences(of: "_", with: " "))")
                    .aceFont(AceDesign.TextRole.caption, relativeTo: .caption2)
                    .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
    }
}

import SwiftUI

private struct HistoryWindowReply: Decodable {
    struct Row: Decodable, Identifiable {
        let item: TranscriptRow
        let seq: Int
        var id: String { item.id }
        private enum Keys: String, CodingKey { case seq }
        init(from decoder: any Decoder) throws {
            item = try TranscriptRow(from: decoder)
            seq = try decoder.container(keyedBy: Keys.self).decode(Int.self, forKey: .seq)
        }
    }
    let target: Int?
    let before: Int?
    let after: Int?
    let rows: [Row]
}

/// Separate bounded history pages keep incoming work in the live tail while older messages are read.
struct ConversationHistoryView: View {
    let model: ClientModel
    let threadId: String
    let title: String
    var itemId: String? = nil
    var openThread: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var window: HistoryWindowReply?
    @State private var items: [ItemModel] = []
    @State private var targetId: String?
    @State private var problem: String?
    @State private var loading = false
    @State private var fullMessage: TranscriptRow?
    @State private var media: TranscriptRow?
    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(items) { item in
                    ItemRowView(item: item, openMedia: { media = $0 }, openMessage: { fullMessage = $0 }, workEnded: true)
                        .padding(.vertical, AceTheme.Spacing.sm)
                        .listRowBackground(item.id == targetId ? AceTheme.Colours.fill : AceTheme.Colours.background)
                        .listRowSeparator(.hidden).id(item.id)
                }
                if loading { ProgressView().accessibilityLabel("Loading messages") }
                if !loading && window != nil && items.isEmpty { EmptyState(icon: .chatCircle, title: "No messages recorded") }
                if let problem { ServiceProblem(message: problem); Button("Retry") { Task { await read() } } }
                if let openThread {
                    Button("Open conversation") { openThread(threadId) }.accessibilityIdentifier("search.openThread")
                }
            }
            .accessibilityIdentifier("history.messages")
            .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
                if let window {
                    HStack {
                        Button("Earlier messages", ace: .caretLeft) { Task { if let before = window.before { await read(sequence: before) } } }
                            .disabled(loading || window.before == nil).accessibilityIdentifier("history.earlier")
                        Spacer(minLength: AceTheme.Spacing.sm)
                        Button("Later messages", ace: .caretRight) { Task { if let after = window.after { await read(sequence: after) } } }
                            .disabled(loading || window.after == nil).accessibilityIdentifier("history.later")
                    }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .frame(minHeight: AceTheme.Dimensions.touchTarget).padding(.horizontal, AceTheme.Spacing.lg)
                    .background(AceTheme.Colours.background)
                    .overlay(alignment: .top) { Rectangle().fill(AceTheme.Colours.separator).frame(height: AceTheme.Dimensions.border) }
                }
            }
            .listStyle(.plain).scrollContentBackground(.hidden).background(AceTheme.Colours.background)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await read() }
            .task(id: targetId) { await Task.yield(); if let targetId, !Task.isCancelled { proxy.scrollTo(targetId, anchor: .center) } }
            .sheet(item: $fullMessage) { FullMessageView(model: model, threadId: threadId, item: $0) }
            .sheet(item: $media) { item in NavigationStack { NativeMediaView(model: model, threadId: threadId, item: item) } }
        }
    }
    private func read(sequence: Int? = nil) async {
        guard !loading else { return }
        loading = true; problem = nil
        defer { loading = false }
        do {
            var request: [String: Any] = ["type": "native.history.window", "threadId": threadId]
            if let sequence { request["aroundSeq"] = sequence }
            else if let itemId { request["itemId"] = itemId }
            else { request["aroundSeq"] = 0 }
            let reply = try await model.service(request, as: HistoryWindowReply.self)
            guard !Task.isCancelled else { return }
            window = reply
            items = reply.rows.map { ItemModel($0.item) }
            targetId = reply.rows.first { $0.seq == reply.target }?.id ?? reply.rows.first?.id
        } catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
}

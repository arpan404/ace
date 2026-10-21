import SwiftUI

/// Follow-ups waiting in the daemon's queue, above the composer. Each can get new words, go now as
/// a steer (where the provider steers), move up or down, or be removed; the daemon's next queue
/// revision moves it.
struct QueueStrip<Indicators: View>: View {
    let queue: QueueRow
    let canAct: Bool
    let canSteer: Bool
    let edit: (QueueRow.Message, [String: Any]) async -> Bool
    /// The strip's other items, at the end of its first line.
    @ViewBuilder var indicators: () -> Indicators
    @State private var editing: QueueRow.Message?
    @State private var words = ""
    @State private var busy: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(queue.label).foregroundStyle(AceTheme.Colours.foreground)
                if !queue.when.isEmpty { Text("· \(queue.when)").foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1) }
                Spacer(minLength: AceTheme.Spacing.none)
                indicators()
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            ForEach(queue.messages) { message in
                HStack(spacing: AceTheme.Spacing.sm) {
                    Text(message.text.isEmpty ? "Attachment" : message.text).lineLimit(2)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.foreground)
                    if message.attachments > 0 { Image(systemName: "paperclip").foregroundStyle(AceTheme.Colours.decoration) }
                    Spacer(minLength: AceTheme.Spacing.none)
                    if busy == message.id { ProgressView().controlSize(.mini) }
                    if canAct {
                        Menu {
                            if canSteer { Button("Send now", systemImage: "arrow.turn.down.right") { run(message, ["kind": "steer"]) } }
                            Button("Edit", systemImage: "pencil") { words = message.text; editing = message }
                            if message.id != queue.messages.first?.id {
                                Button("Move up", systemImage: "arrow.up") { run(message, ["kind": "move", "step": -1]) }
                            }
                            if message.id != queue.messages.last?.id {
                                Button("Move down", systemImage: "arrow.down") { run(message, ["kind": "move", "step": 1]) }
                            }
                            Button("Remove", systemImage: "trash", role: .destructive) { run(message, ["kind": "remove"]) }
                        } label: {
                            Image(systemName: "ellipsis").frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
                                .foregroundStyle(AceTheme.Colours.mutedForeground).contentShape(Rectangle())
                        }
                        .disabled(busy != nil)
                        .accessibilityLabel("Queued message options")
                        .accessibilityIdentifier("queue.menu")
                    }
                }
                .accessibilityElement(children: .contain)
            }
            if queue.more > 0 {
                Text("+\(queue.more) more").aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
            }
        }
        .accessibilityIdentifier("queue.strip")
        .alert("Edit queued message", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
            TextField("Message", text: $words, axis: .vertical)
            Button("Save") { if let message = editing { run(message, ["kind": "words", "text": words]) } }
                .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        }
    }
    private func run(_ message: QueueRow.Message, _ change: [String: Any]) {
        busy = message.id
        Task { _ = await edit(message, change); busy = nil }
    }
}

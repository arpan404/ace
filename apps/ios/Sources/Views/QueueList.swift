import SwiftUI

/// Follow-ups waiting in the daemon's queue, in the sheet the pill's "2 queued" opens. Each can get
/// new words, go now as a steer (where the provider steers), move up or down, or be removed; the
/// daemon's next queue revision moves it. The header carries the queue's own Pause queue or Resume
/// queue; a long queue lists a page at a time, with Show more under it.
struct QueueList: View {
    let queue: QueueRow
    let canAct: Bool
    let canSteer: Bool
    let edit: (QueueRow.Message, [String: Any]) async -> Bool
    var act: (QueueRow.Action) async -> Bool = { _ in false }
    var showMore: () -> Void = {}
    /// A queued message's full words, and saving new ones where it waits (`MessageEditSheet`).
    var words: (String) async -> WordsRequests.Answer = { _ in WordsRequests.unsent }
    var saveWords: (String, String, Int?) async -> String? = { _, _, _ in "This phone can only view this machine." }
    @State private var editor: MessageEditor?
    /// Remove asks first: the message is gone once it's done.
    @State private var removing: QueueRow.Message?
    @State private var acting = false
    @State private var toggled = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var busy: String?
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(queue.label).foregroundStyle(AceTheme.Colours.foreground)
                if !queue.when.isEmpty { Text("· \(queue.when)").foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1) }
                Spacer(minLength: AceTheme.Spacing.none)
                if canAct, let control = queue.control {
                    Button(control.label) {
                        acting = true
                        Task {
                            if await act(control) { toggled += 1 }
                            acting = false
                        }
                    }
                    .buttonStyle(StripTextButtonStyle())
                    .disabled(acting)
                    .accessibilityIdentifier("queue.control")
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .frame(minHeight: AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm)
            ForEach(queue.messages) { message in
                HStack(spacing: AceTheme.Spacing.sm) {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        Text(message.text.isEmpty ? "Attachment" : message.text).lineLimit(2)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.foreground)
                        // The daemon can't tell whether it reached the agent: sending it again may run it twice.
                        if message.state == "uncertain" {
                            Text("May have reached the agent").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                                .foregroundStyle(AceTheme.Colours.mutedForeground)
                        }
                    }
                    if message.attachments > 0 { AceIcon(.paperclip, size: 14, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.decoration) }
                    Spacer(minLength: AceTheme.Spacing.none)
                    if busy == message.id { ProgressView().controlSize(.mini) }
                    if canAct {
                        Menu {
                            if canSteer { Button("Send now", ace: .arrowBendUpRight) { run(message, ["kind": "steer"]) } }
                            Button("Edit", ace: .pencilSimple) {
                                editor = MessageEditor(attachments: message.attachments,
                                                       read: { await words(message.id) },
                                                       write: { await saveWords(message.id, $0, $1) })
                            }
                            if message.id != queue.messages.first?.id {
                                Button("Move up", ace: .arrowUp) { run(message, ["kind": "move", "step": -1]) }
                            }
                            if message.id != queue.messages.last?.id {
                                Button("Move down", ace: .arrowDown) { run(message, ["kind": "move", "step": 1]) }
                            }
                            Button("Remove", ace: .trash, role: .destructive) { removing = message }
                        } label: {
                            AceIcon(.dotsThree, size: 20).frame(width: AceTheme.Dimensions.touchTarget, height: AceTheme.Dimensions.touchTarget)
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
                Button("Show \(queue.more) more") { withAnimation(reduceMotion ? nil : .smooth) { showMore() } }
                    .buttonStyle(StripTextButtonStyle())
                    .monospacedDigit()
                    .padding(.leading, -AceTheme.Spacing.sm)
                    .accessibilityIdentifier("queue.more")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("queue.strip")
        .animation(reduceMotion ? nil : .smooth, value: queue.messages.map(\.id))
        .animation(reduceMotion ? nil : .smooth, value: queue.control)
        .sensoryFeedback(.impact(weight: .light), trigger: toggled)
        .sheet(item: $editor) { MessageEditSheet(editor: $0) }
        .confirmationDialog("Remove this message?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible, presenting: removing) { message in
            Button("Remove message", role: .destructive) { run(message, ["kind": "remove"]) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in Text("It won't be sent.") }
    }
    private func run(_ message: QueueRow.Message, _ change: [String: Any]) {
        busy = message.id
        Task { _ = await edit(message, change); busy = nil }
    }
}

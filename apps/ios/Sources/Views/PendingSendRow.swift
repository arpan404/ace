import SwiftUI

/// A message the phone holds that hasn't reached the transcript yet, from the SDK's state: the
/// bubble as it will read, then how its sending goes, as the web words it: "Sending…" (or the
/// shared unsent wording, such as "Sends on reconnect"), or "Not sent" with Retry, Edit (its words
/// changed in place in the outbox, then Retry sends them), Discard and the reason behind Details.
struct PendingSendRow: View {
    let row: PendingRow
    let canRetry: Bool
    let retry: () async -> Bool
    /// The failed send's full words, and saving new ones in place; nil offers no Edit.
    var words: (() async -> WordsRequests.Answer)? = nil
    var saveWords: ((String) async -> String?)? = nil
    var discard: (() async -> Bool)? = nil
    @State private var editor: MessageEditor?
    var body: some View {
        if row.state == "failed" {
            NotSentMessage(text: row.text, attachments: row.files ?? 0, reason: "", detail: row.detail ?? "",
                           canAct: canRetry, retryLabel: "Retry", removeLabel: "Discard", retry: retry,
                           edit: words.flatMap { read in saveWords.map { write in {
                               editor = MessageEditor(attachments: row.files ?? 0, read: read, write: write)
                           } } },
                           remove: discard)
                .sheet(item: $editor) { MessageEditSheet(editor: $0) }
        } else {
            VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
                UserBubble(text: row.text, id: row.id)
                HStack(spacing: AceTheme.Spacing.xs) {
                    AceIcon(.clock, size: 12, relativeTo: .caption)
                    Text(row.label ?? "Sending…")
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .accessibilityElement(children: .combine)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

/// The message a failed send or session start left at the head of the daemon's queue, where it
/// was written: "Not sent · the short reason", Try again (resumes the held queue), Edit (its words
/// changed where it waits) and Remove, and the provider's detail behind Details. The messages
/// behind it wait for it.
struct HeldSendRow: View {
    let message: QueueRow.NotSent
    let canAct: Bool
    let act: (QueueRow.Action) async -> Bool
    let edit: (QueueRow.Message, [String: Any]) async -> Bool
    /// The message's full words from the daemon's queue, and saving new ones in place.
    let words: () async -> WordsRequests.Answer
    let saveWords: (String) async -> String?
    @State private var editor: MessageEditor?
    var body: some View {
        let queued = QueueRow.Message(id: message.id, text: message.text, delivery: "queue", state: "queued", attachments: message.attachments)
        NotSentMessage(text: message.text, attachments: message.attachments, reason: message.reason, detail: message.detail,
                       canAct: canAct, retryLabel: "Try again", removeLabel: "Remove",
                       retry: { await act(QueueRow.Action(id: "resume", label: "Try again")) },
                       edit: { editor = MessageEditor(attachments: message.attachments, read: words, write: saveWords) },
                       remove: { await edit(queued, ["kind": "remove"]) })
            .sheet(item: $editor) { MessageEditSheet(editor: $0) }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("heldSend")
    }
}

/// The bubble, "Not sent · reason" in the failed colour, then its ways on as words and Details.
/// Remove asks first: the words are gone once it's done.
struct NotSentMessage: View {
    let text: String
    let attachments: Int
    let reason: String
    let detail: String
    let canAct: Bool
    let retryLabel: String
    let removeLabel: String
    let retry: () async -> Bool
    /// Opens the edit sheet.
    let edit: (() -> Void)?
    let remove: (() async -> Bool)?
    @State private var busy = false
    @State private var details = false
    @State private var confirming = false
    @State private var recovered = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        VStack(alignment: .trailing, spacing: AceTheme.Spacing.xs) {
            if !text.isEmpty { UserBubble(text: text) }
            if attachments > 0 {
                Label { Text(attachments == 1 ? "1 file" : "\(attachments) files") } icon: { AceIcon(.paperclip, size: 12, relativeTo: .caption) }
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            NotSentLine(reason: reason).accessibilityIdentifier("notSent.reason")
            if canAct || !detail.isEmpty {
                HStack(spacing: AceTheme.Spacing.none) {
                    if !detail.isEmpty {
                        Button(details ? "Hide details" : "Details") { withAnimation(reduceMotion ? nil : .smooth) { details.toggle() } }
                            .buttonStyle(StripTextButtonStyle())
                            .accessibilityIdentifier("notSent.details")
                    }
                    if canAct {
                        Button(retryLabel) { run(retry) }
                            .buttonStyle(StripTextButtonStyle(prominent: true))
                            .accessibilityIdentifier("pending.retry")
                        if let edit {
                            Button("Edit") { edit() }.buttonStyle(StripTextButtonStyle())
                                .accessibilityIdentifier("notSent.edit")
                        }
                        if remove != nil {
                            Button(removeLabel) { confirming = true }.buttonStyle(StripTextButtonStyle())
                                .accessibilityIdentifier("notSent.remove")
                        }
                    }
                }
                .disabled(busy)
                .padding(.trailing, -AceTheme.Spacing.sm)
            }
            if details {
                Text(detail).aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.leading, UserBubble.inset)
                    .accessibilityIdentifier("notSent.detail")
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .sensoryFeedback(.success, trigger: recovered)
        .confirmationDialog("\(removeLabel) this message?", isPresented: $confirming, titleVisibility: .visible) {
            Button("\(removeLabel) message", role: .destructive) { if let remove { run(remove) } }
            Button("Cancel", role: .cancel) {}
        } message: { Text("It won't be sent.") }
    }
    private func run(_ action: @escaping () async -> Bool) {
        busy = true
        Task {
            if await action() { recovered += 1 }
            busy = false
        }
    }
}

import SwiftUI

/// A bot's conversation as a chat (ADR 0127), as the web's `SpadeChat` draws it: the person's
/// bubbles on the right, the bot's on the left with its face beside the last of each run, other
/// bots' messages under their name, and nothing of how the bot works. An approval arrives as the
/// bot's bubble with Allow and Deny. While the bot works, one line under its last bubble: its
/// face, its few words, and Stop.
struct SpadeChat: View {
    let model: ClientModel
    let bot: SpadeModel.Bot?
    let conversation: SpadeModel.Conversation
    let stopping: Bool
    let stop: () -> Void
    let answer: (_ callId: String, _ allowed: Bool, _ always: Bool) async -> Bool
    let retry: (String) -> Void

    private var spade: SpadeModel { model.spade }

    var body: some View {
        let keys = spade.order.filter { spade.bubbles[$0] != nil }
        LazyVStack(alignment: .leading, spacing: AceDesign.Space.related) {
            ForEach(Array(keys.enumerated()), id: \.element) { index, key in
                if let bubble = spade.bubbles[key] {
                    let next = keys.indices.contains(index + 1) ? spade.bubbles[keys[index + 1]] : nil
                    let last = index == keys.count - 1
                    // The face sits by the last of a run of the bot's bubbles, or by the status line.
                    let face = bubble.botSide && next?.botSide != true && !(conversation.busy && last)
                    SpadeBubbleView(model: model, bot: bot, bubble: bubble, key: key, face: face,
                                    answer: answer, retry: retry)
                        // Each approval is its own bubble: the next one queued starts with its buttons on.
                        .id(key)
                }
            }
            if let status = conversation.status { statusLine(status) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.chat")
    }

    private func statusLine(_ status: SpadeModel.Status) -> some View {
        HStack(spacing: AceDesign.Space.related) {
            if let bot { SpadeBotFace(model: model, face: bot.face, working: status.moving) }
            Text(status.text)
                .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                .foregroundStyle(AceDesign.Ink.muted)
                .lineLimit(1)
            Spacer(minLength: AceDesign.Space.related)
            Button(stopping ? "Stopping…" : "Stop", action: stop)
                .buttonStyle(.textAction())
                .disabled(stopping)
                .accessibilityLabel("Stop \(bot?.name ?? "Spade")")
                .accessibilityIdentifier("spade.stop")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.status")
    }
}

private struct SpadeBubbleView: View {
    let model: ClientModel
    let bot: SpadeModel.Bot?
    let bubble: SpadeModel.Bubble
    let key: String
    let face: Bool
    let answer: (_ callId: String, _ allowed: Bool, _ always: Bool) async -> Bool
    let retry: (String) -> Void

    var body: some View {
        switch bubble {
        case .person(let text, let attachments, let sending):
            VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
                if let attachments { quiet(attachments) }
                if !text.isEmpty { UserBubble(text: text, id: key) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
            .opacity(sending ? AceDesign.Ink.pressed : 1)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("spade.bubble.person")
        case .bot(let text, let live, let end, let failure, let attachments):
            botRow {
                VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                    if !text.isEmpty { AceMarkdown(text: text, streaming: live) }
                    if let failure { SpadeFailureLine(failure: failure, retry: retry) }
                    else if let end { quiet(end) }
                    if let attachments { quiet(attachments) }
                }
            }
            .accessibilityIdentifier("spade.bubble.bot")
        case .other(let name, let text):
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                quiet(name).padding(.leading, faceRoom)
                botRow(own: false) { AceMarkdown(text: text) }
            }
            .accessibilityIdentifier("spade.bubble.other")
        case .label(let label, let text):
            VStack(spacing: AceDesign.Space.tight) {
                quiet(label)
                if let text { quiet(text).multilineTextAlignment(.center).lineLimit(3) }
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
        case .note(let text):
            quiet(text).padding(.leading, faceRoom)
        case .ask(let callId, let sentence, let reason, let command, let details):
            botRow {
                SpadeAsk(sentence: sentence, reason: reason, command: command, details: details) { allowed, always in
                    await answer(callId, allowed, always)
                }
            }
            .accessibilityIdentifier("spade.bubble.ask")
        }
    }

    private var faceRoom: CGFloat { AceDesign.Size.avatar + AceDesign.Space.related }

    /// The bot's side: its face by the last of a run (or the room for it), then the bubble.
    /// Another bot's message keeps the room: the phone doesn't have that bot's face.
    private func botRow(own: Bool = true, @ViewBuilder content: () -> some View) -> some View {
        let drawn = own && face ? bot?.face : nil
        return HStack(alignment: .bottom, spacing: AceDesign.Space.related) {
            if let drawn { SpadeBotFace(model: model, face: drawn) } else { Color.clear.frame(width: AceDesign.Size.avatar, height: 1) }
            content()
                .padding(.horizontal, AceDesign.Space.bubbleH).padding(.vertical, AceDesign.Space.bubbleV)
                .overlay(RoundedRectangle(cornerRadius: AceDesign.Size.bubbleCorner, style: .continuous)
                    .stroke(AceTheme.Colours.separator, lineWidth: 1))
            Spacer(minLength: UserBubble.inset)
        }
        .accessibilityElement(children: .contain)
    }

    private func quiet(_ text: String) -> some View {
        Text(text).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
    }
}

/// Why a reply failed, Try again with the person's last words when it can, and Details.
private struct SpadeFailureLine: View {
    let failure: SpadeModel.Failure
    let retry: (String) -> Void
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(failure.sentence).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
            if open, let details = failure.details { SpadeDetails(text: details) }
            HStack(spacing: AceDesign.Space.related) {
                if let words = failure.retry { Button("Try again") { retry(words) }.buttonStyle(.textAction()) }
                if failure.details != nil {
                    Button("Details") { open.toggle() }.buttonStyle(.textAction()).accessibilityValue(open ? "Shown" : "Hidden")
                }
            }
        }
    }
}

/// The bot asks to use a tool: its sentence, why the review asked, then Allow, Deny and Details.
/// A command shows itself instead of Details, with Always allow this command. A taken answer
/// keeps the buttons off until Spade stores it and the bubble goes.
private struct SpadeAsk: View {
    let sentence: String
    let reason: String?
    let command: String?
    let details: String?
    /// Resolves whether Spade took the answer.
    let answer: (_ allowed: Bool, _ always: Bool) async -> Bool
    @State private var answering: String?
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(sentence).aceFont(AceTheme.Typography.body, relativeTo: .body)
            if let reason {
                Text("Asked you because: \(reason)").aceFont(AceDesign.TextRole.meta, relativeTo: .footnote).foregroundStyle(AceDesign.Ink.muted)
            }
            if let command { SpadeDetails(text: command) }
            if open, let details { SpadeDetails(text: details) }
            HStack(spacing: AceDesign.Space.related) {
                choice("allow", answering == "allow" ? "Allowing…" : "Allow", allowed: true, always: false, prominent: true)
                if command != nil { choice("always", answering == "always" ? "Allowing…" : "Always allow this command", allowed: true, always: true) }
                choice("deny", answering == "deny" ? "Denying…" : "Deny", allowed: false, always: false)
                if details != nil {
                    Button("Details") { open.toggle() }.buttonStyle(.textAction()).accessibilityValue(open ? "Shown" : "Hidden")
                        .accessibilityIdentifier("spade.ask.details")
                }
            }
        }
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: answering) { (_: String?, now: String?) -> Bool in
            now.map { ["allow", "always"].contains($0) } ?? false
        }
    }

    private func choice(_ id: String, _ label: String, allowed: Bool, always: Bool, prominent: Bool = false) -> some View {
        Button(label) {
            answering = id
            Task { if !(await answer(allowed, always)) { answering = nil } }
        }
        .buttonStyle(.textAction(prominent ? .prominent : .plain))
        .disabled(answering != nil)
        .accessibilityIdentifier("spade.ask.\(id)")
    }
}

/// A call's command or arguments, as code, selectable.
private struct SpadeDetails: View {
    let text: String
    var body: some View {
        ScrollView {
            Text(verbatim: text)
                .aceMonospace(AceDesign.TextRole.meta, relativeTo: .footnote)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 180)
    }
}

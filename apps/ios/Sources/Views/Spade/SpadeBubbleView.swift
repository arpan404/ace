import SwiftUI

/// One bubble of a Spade conversation as the bridge put it (`bridge/spade-rows.ts`): the
/// person's on the right in the accent, the bot's on the left on the page's fill with its words
/// as markdown, an approval as a raised card with its answers, a quiet line for the rest.
struct SpadeBubbleView: View {
    let bubble: SpadeModel.Bubble
    /// An approval's answer: its call, allowed or not, and whether always; true once it went.
    let answer: (String, Bool, Bool) async -> Bool

    var body: some View {
        switch bubble {
        case let .person(text, sending, attached):
            HStack(spacing: AceTheme.Spacing.none) {
                Spacer(minLength: UserBubble.inset)
                VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
                    if let attached { Text(attached).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted) }
                    if !text.isEmpty {
                        Text(text)
                            .aceFont(AceDesign.TextRole.message)
                            .foregroundStyle(AceDesign.Surface.background)
                            .padding(.horizontal, AceDesign.Space.margin)
                            .padding(.vertical, AceDesign.Space.related)
                            .background(AceDesign.Ink.accent, in: AceDesign.Shape.bubble)
                            .opacity(sending ? AceTheme.Opacity.disabled(.light) : 1)
                            .textSelection(.enabled)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("spade.bubble.person")
        case let .bot(text, live, end):
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if !text.isEmpty { AceMarkdown(text: text, streaming: live) }
                if let end {
                    Text(end.text)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(end.alert ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                }
            }
            .padding(.horizontal, AceDesign.Space.margin)
            .padding(.vertical, AceDesign.Space.related)
            .background(AceDesign.Surface.fill, in: AceDesign.Shape.bubble)
            .padding(.trailing, AceDesign.Space.section)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("spade.bubble.bot")
        case let .ask(callId, sentence, detail, reason, always):
            SpadeApprovalCard(sentence: sentence, detail: detail, reason: reason, always: always) { allowed, forever in
                await answer(callId, allowed, forever)
            }
        case let .note(text):
            Text(text)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("spade.note")
        }
    }
}

/// A request waiting on the person, raised above the chat: its sentence after the needs-you
/// glyph, the detail that matters (a command, a path), why it asks when the review said, then
/// Deny, Always allow and Allow as the thread's own approval buttons, Allow the prominent one.
private struct SpadeApprovalCard: View {
    let sentence: String
    let detail: String?
    let reason: String?
    let always: Bool
    let answer: (Bool, Bool) async -> Bool
    /// An answer is out: the buttons wait; a refused one gives them back.
    @State private var answered = false

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
                StatusGlyph(.needsYou, tone: .needsYou, size: AceDesign.Size.icon)
                RequestHeader(title: sentence, detail: reason ?? "")
            }
            if let detail { CommandBlock(command: detail) }
            RequestActions {
                CardButton(title: "Deny") { reply(false, false) }
                    .accessibilityIdentifier("spade.deny")
                if always {
                    CardButton(title: "Always allow") { reply(true, true) }
                        .accessibilityIdentifier("spade.alwaysAllow")
                }
                CardButton(title: "Allow", primary: true) { reply(true, false) }
                    .accessibilityIdentifier("spade.allow")
            }
            .disabled(answered)
        }
        .padding(AceDesign.Space.margin)
        .background(AceDesign.Surface.raised, in: AceDesign.Shape.container)
        .floatingShadow()
        .sensoryFeedback(AceDesign.Haptic.approve, trigger: answered)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("spade.approval")
    }

    private func reply(_ allowed: Bool, _ forever: Bool) {
        answered = true
        Task { answered = await answer(allowed, forever) }
    }
}

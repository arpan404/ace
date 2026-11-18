import SwiftUI

/// One bubble of a Spade conversation as the bridge put it (`bridge/spade-rows.ts`): the
/// person's on the right in the accent, the bot's on the left on the page's fill with its words
/// as markdown, an approval as a raised card with its answers, a card of questions, a quiet line
/// for the rest.
struct SpadeBubbleView: View {
    let bubble: SpadeModel.Bubble
    /// An approval's answer: its call, allowed or not, and whether always; true once it went.
    let answer: (String, Bool, Bool) async -> Bool
    /// Cards for later the person opened, by call.
    var unfolded: Set<String> = []
    var fold: (String, Bool) -> Void = { _, _ in }
    /// A card's reply: its call and what it sends.
    var reply: (String, [String: Any]) async -> SpadeOutcome = { _, _ in SpadeOutcome(ok: false) }

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
        case let .question(card):
            SpadeQuestionCardView(card: card, unfolded: unfolded.contains(card.callId),
                                  fold: { fold(card.callId, $0) }, reply: { await reply(card.callId, $0) })
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
/// Deny and Always allow as quiet words and Allow as the one primary.
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
            HStack(spacing: AceTheme.Spacing.xxs) {
                Button("Deny") { reply(false, false) }.buttonStyle(RequestButtonStyle())
                    .accessibilityIdentifier("spade.deny")
                if always {
                    Button("Always allow") { reply(true, true) }.buttonStyle(RequestButtonStyle())
                        .accessibilityIdentifier("spade.alwaysAllow")
                }
                Spacer(minLength: AceTheme.Spacing.none)
                Button("Allow") { reply(true, false) }.buttonStyle(RequestButtonStyle(primary: true))
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

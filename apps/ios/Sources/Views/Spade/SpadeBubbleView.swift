import SwiftUI

/// One bubble of a Spade conversation as the bridge put it (`bridge/spade-rows.ts`): the
/// person's on the right in the accent with its pictures and documents above it as a thread
/// message's and a voice message's Play, the bot's on the left on the page's fill with its words
/// as markdown and what its tools showed under them, an approval as a raised card
/// with its answers, a card of questions, a reply's changes to its files with their Undo
/// (`SpadeChangesLine`), a quiet line for the rest.
struct SpadeBubbleView: View {
    let bubble: SpadeModel.Bubble
    /// An approval's answer: its call, allowed or not, and whether always; true once it went.
    let answer: (String, Bool, Bool) async -> Bool
    /// Cards for later the person opened, by call.
    var unfolded: Set<String> = []
    var fold: (String, Bool) -> Void = { _, _ in }
    /// A card's reply: its call and what it sends.
    var reply: (String, [String: Any]) async -> SpadeOutcome = { _, _ in SpadeOutcome(ok: false) }
    /// Whether a card's reply is out and not yet settled, by call.
    var sending: (String) -> Bool = { _ in false }
    /// What a card's inputs hold, by call, kept beyond the card's view.
    var drafts: (String) -> Binding<[SpadeQuestionCard.Draft]> = { _ in .constant([]) }
    /// A voice message's recording, by its hash; nil when it couldn't be read.
    var audio: @MainActor (String) async -> Data? = { _ in nil }
    /// The bot whose files a reply's Undo puts back; nil where there is none (a group's chat).
    var undoing: SpadeUndoTarget? = nil

    var body: some View {
        switch bubble {
        case let .person(text, sending, attached, images, files, voice):
            HStack(spacing: AceTheme.Spacing.none) {
                Spacer(minLength: UserBubble.inset)
                VStack(alignment: .trailing, spacing: AceDesign.Space.tight) {
                    // Spade names a picture or document by its hash alone, so no message id is needed.
                    if !images.isEmpty || !files.isEmpty { MessageAttachments(itemId: "", attachments: images + files, more: 0) }
                    if let attached { Text(attached).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted) }
                    if let voice { SpadeVoicePlay(voice: voice, read: audio, onAccent: true).opacity(sending ? AceTheme.Opacity.disabled(.light) : 1) }
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
            // Contained, not combined: each picture, file and Play stays its own button.
            .accessibilityElement(children: images.isEmpty && files.isEmpty && voice == nil ? .combine : .contain)
            .accessibilityIdentifier("spade.bubble.person")
        case let .bot(text, live, fold, end, images, files):
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if !text.isEmpty || end != nil {
                    VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                        if !text.isEmpty { SpadeFoldedWords(text: text, streaming: live, fold: fold) }
                        if let end {
                            Text(end.text)
                                .aceFont(AceDesign.TextRole.meta)
                                .foregroundStyle(end.alert ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                        }
                    }
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.vertical, AceDesign.Space.related)
                    .background(AceDesign.Surface.fill, in: AceDesign.Shape.bubble)
                    // One element to read; a folding one keeps its words and Show more apart.
                    .accessibilityElement(children: fold ? .contain : .combine)
                }
                // What its tools showed: pictures open full size, documents in Quick Look.
                if !images.isEmpty || !files.isEmpty { MessageAttachments(itemId: "", attachments: images + files, more: 0) }
            }
            .padding(.trailing, AceDesign.Space.section)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("spade.bubble.bot")
        case let .ask(callId, sentence, detail, reason, always, approvers):
            SpadeApprovalCard(sentence: sentence, detail: detail, reason: reason, always: always, approvers: approvers) { allowed, forever in
                await answer(callId, allowed, forever)
            }
        case let .question(card):
            SpadeQuestionCardView(card: card, unfolded: unfolded.contains(card.callId), sending: sending(card.callId),
                                  drafts: drafts(card.callId), fold: { fold(card.callId, $0) }, reply: { await reply(card.callId, $0) })
        case let .member(name, text, fold, face, first, last):
            SpadeMemberBubble(name: name, text: text, fold: fold, face: face, first: first, last: last)
        // Drawn by the chat, which has the client its requests answer through (`SpadeWorkersCard`).
        case .workers:
            EmptyView()
        case let .changes(changes):
            SpadeChangesLine(changes: changes, target: undoing)
        case let .note(text):
            Text(text)
                .aceFont(AceDesign.TextRole.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityIdentifier("spade.note")
        }
    }
}

/// A member's message in a group, as a group chat shows people: its name above the first of a
/// run, its face beside the last, the bubbles between lined up with it.
private struct SpadeMemberBubble: View {
    let name: String
    let text: String
    let fold: Bool
    let face: SpadeModel.Face
    let first: Bool
    let last: Bool
    private static let face = AceDesign.Size.barIcon + AceDesign.Space.related

    var body: some View {
        HStack(alignment: .bottom, spacing: AceDesign.Space.related) {
            Group {
                if last { SpadeFaceView(face: face, size: Self.face) } else { Color.clear }
            }
            .frame(width: Self.face, height: Self.face)
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                if first {
                    Text(name)
                        .aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .padding(.leading, AceDesign.Space.margin)
                }
                SpadeFoldedWords(text: text, fold: fold)
                    .padding(.horizontal, AceDesign.Space.margin)
                    .padding(.vertical, AceDesign.Space.related)
                    .background(AceDesign.Surface.fill, in: AceDesign.Shape.bubble)
            }
            .padding(.trailing, AceDesign.Space.section)
        }
        .padding(.top, first ? AceDesign.Space.related : AceTheme.Spacing.none)
        .modifier(MemberAccessibility(label: "\(name): \(text)", fold: fold))
        .accessibilityIdentifier("spade.bubble.member")
    }
}

/// A member's message reads as one element, its name first; a folding one keeps its words and
/// Show more apart, so Show more can be reached.
private struct MemberAccessibility: ViewModifier {
    let label: String
    let fold: Bool
    func body(content: Content) -> some View {
        if fold {
            content.accessibilityElement(children: .contain)
        } else {
            content.accessibilityElement(children: .combine).accessibilityLabel(label)
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
    /// A shared bot's request: who may answer it, one quiet line above the buttons.
    let approvers: String?
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
            if let approvers {
                Text(approvers)
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityIdentifier("spade.approvers")
            }
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

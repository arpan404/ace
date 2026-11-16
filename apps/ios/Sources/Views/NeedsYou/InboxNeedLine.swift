import SwiftUI

/// The line a needs-you row grows under its title: what the first request waits on, across the
/// row's width. An approval shows its command in mono in a capsule, cut in the middle; a question
/// its prompt; a plan, a form or browser help a sentence. Several waiting read "1 of 3" quietly.
/// The line holds no buttons: a tap on the row opens the thread, and an approval answers by the
/// row's swipes, long-press menu and VoiceOver actions (`NeedActions.answers`). While an answer is
/// on its way the line says so ("Sending…"); it leaves only when the daemon closes the request.
/// The third line's height, as a branch's, on the row's one left edge.
struct InboxNeedLine: View {
    let requests: [ApprovalRow]
    /// What waits: here, in delegated work, and whether the read found it all.
    let tally: NeedTally
    let model: ClientModel
    @Environment(\.dynamicTypeSize) private var typeSize

    /// What VoiceOver reads for the line, inside the row's name.
    var spoken: String? {
        guard let request = requests.first else { return nil }
        let subject = request.kind == "approval" && !request.command.isEmpty ? request.command : NeedWords.subject(request)
        return [NeedWords.sentence(request), subject, NeedWords.spokenPosition(tally)].compactMap { $0 }.joined(separator: ", ")
    }

    var body: some View {
        if let request = requests.first {
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                // At accessibility sizes the subject takes a second line rather than cutting more.
                NeedSubject(request: request, lines: typeSize.isAccessibilitySize ? 2 : 1)
                if let position = NeedWords.position(tally) {
                    Text(position)
                        .aceFont(AceDesign.TextRole.time).monospacedDigit()
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .fixedSize()
                        .accessibilityLabel(NeedWords.spokenPosition(tally) ?? position)
                }
                if let progress = NeedActions.progress(model.approvalSubmissions[request.id]) {
                    Text(progress)
                        .aceFont(AceDesign.TextRole.time, relativeTo: .caption)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .fixedSize()
                        .accessibilityIdentifier("inbox.need.progress")
                }
            }
            .frame(minHeight: InboxRowType.lastLine)
            .accessibilityIdentifier("inbox.need")
        }
    }
}

/// What the request is: an approval's command (or what it touches) in a mono capsule, otherwise
/// its sentence in muted ink. It takes the line's whole width.
private struct NeedSubject: View {
    let request: ApprovalRow
    let lines: Int
    var body: some View {
        let payload = request.command.isEmpty ? (request.strip?.payload ?? "") : request.command
        if request.kind == "approval" && !payload.isEmpty {
            Text(payload)
                .aceMonospace(AceDesign.TextRole.code)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(lines).truncationMode(.middle)
                .padding(.horizontal, AceDesign.Space.related)
                .frame(minHeight: InboxRowType.lastLine)
                .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(-1)
        } else {
            Text(NeedWords.subject(request))
                .aceFont(InboxRowType.line, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(lines)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(-1)
        }
    }
}

/// A row's text action: a word, the primary one in the accent and semibold, the rest muted.
/// Drawn on the line; 44pt to the finger.
struct NeedWordStyle: ButtonStyle {
    var primary = false
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceDesign.TextRole.action)
            .fontWeight(primary ? AceDesign.Typeface.strong : AceDesign.Typeface.regular)
            .foregroundStyle(primary ? AceTheme.Colours.accent : AceTheme.Colours.mutedForeground)
            .padding(.horizontal, AceDesign.Space.stripWord)
            .frame(minHeight: AceDesign.Size.rowNeedLine)
            .tapBand(drawn: AceDesign.Size.rowNeedLine)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .opacity(enabled ? 1 : AceTheme.Opacity.disabled(scheme))
            .contentShape(Rectangle())
    }
}

/// A secondary action that stands on its own line (the run's standing grant): plain words in the
/// reading ink, so it reads as something to press rather than a caption. 44pt to the finger.
struct NeedActionStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    @Environment(\.colorScheme) private var scheme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .aceFont(AceDesign.TextRole.action)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(1)
            .padding(.horizontal, AceDesign.Space.stripWord)
            .frame(minHeight: AceDesign.Size.tap)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .opacity(enabled ? 1 : AceTheme.Opacity.disabled(scheme))
            .contentShape(Rectangle())
    }
}

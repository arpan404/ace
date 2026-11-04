import SwiftUI

/// The line a needs-you row grows under its title: the first request in one line and its text
/// actions at the right. An approval shows its command in mono in a capsule, cut in the middle,
/// with Deny (muted) and Allow once (accent); a question its prompt with Answer; a plan, a form or
/// browser help a sentence with Review or Open. Several waiting read "1 of 3" quietly. While an
/// answer is on its way the actions give way to what is happening ("Allowing…"); the line leaves
/// only when the daemon closes the request. Fixed height, on the row's one left edge.
struct InboxNeedLine: View {
    let requests: [ApprovalRow]
    let total: Int
    let model: ClientModel
    let threadId: String
    /// Opens the thread, for what the phone answers there (browser help, long questions).
    let open: () -> Void
    @State private var sheet: RequestSheetItem?
    @State private var decided = 0

    /// What VoiceOver reads for the line, inside the row's name.
    var spoken: String? {
        guard let request = requests.first else { return nil }
        let subject = request.kind == "approval" && !request.command.isEmpty ? request.command : NeedWords.subject(request)
        let count = total > 1 ? "1 of \(total) requests" : nil
        return [NeedWords.sentence(request), subject, count].compactMap { $0 }.joined(separator: ", ")
    }

    var body: some View {
        if let request = requests.first {
            HStack(alignment: .center, spacing: AceDesign.Space.related) {
                NeedSubject(request: request)
                if total > 1 {
                    Text("1 of \(total)")
                        .aceFont(AceDesign.TextRole.time, relativeTo: .caption).monospacedDigit()
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                        .fixedSize()
                        .accessibilityLabel("1 of \(total) requests")
                }
                // The words' own inset sits outside the row's trailing edge, so they end with it.
                words(request).fixedSize().padding(.trailing, -AceDesign.Space.stripWord)
            }
            .frame(height: AceDesign.Size.rowNeedLine)
            .sensoryFeedback(AceDesign.Haptic.approve, trigger: decided)
            .sheet(item: $sheet) { item in
                if let shown = requests.first(where: { $0.id == item.id }) {
                    NeedsRequestSheet(request: shown, model: model, threadId: threadId, open: open) { sheet = nil }
                }
            }
            // The request a sheet shows was answered: the sheet goes with it.
            .onChange(of: requests.map(\.id)) { _, ids in if let item = sheet, !ids.contains(item.id) { sheet = nil } }
            .accessibilityIdentifier("inbox.need")
        }
    }

    @ViewBuilder private func words(_ request: ApprovalRow) -> some View {
        let actions = NeedActions(request: request, model: model, threadId: threadId, open: open,
                                  review: { sheet = RequestSheetItem(id: request.id) }, decided: { decided += 1 })
        if let progress = actions.progress {
            Text(progress)
                .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .padding(.horizontal, AceDesign.Space.stripWord)
                .accessibilityIdentifier("inbox.need.progress")
        } else if model.canOperate {
            HStack(spacing: AceTheme.Spacing.none) {
                ForEach(actions.row) { action in
                    Button(action.label, action: action.run)
                        .buttonStyle(NeedWordStyle(primary: action.primary))
                        .accessibilityIdentifier("inbox.need.\(action.id)")
                }
            }
        }
    }
}

/// What the request is, in one line: an approval's command (or what it touches) in a mono
/// capsule, otherwise its sentence in muted ink.
private struct NeedSubject: View {
    let request: ApprovalRow
    var body: some View {
        let payload = request.command.isEmpty ? (request.strip?.payload ?? "") : request.command
        if request.kind == "approval" && !payload.isEmpty {
            Text(payload)
                .aceMonospace(AceDesign.TextRole.code, relativeTo: .caption)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1).truncationMode(.middle)
                .padding(.horizontal, AceDesign.Space.related)
                .frame(height: AceDesign.Size.rowNeedLine)
                .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
                .frame(maxWidth: .infinity, alignment: .leading)
                .layoutPriority(-1)
        } else {
            Text(NeedWords.subject(request))
                .aceFont(InboxRowType.line, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
                .lineLimit(1)
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
            .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
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
            .aceFont(AceDesign.TextRole.action, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.foreground)
            .lineLimit(1)
            .padding(.horizontal, AceDesign.Space.stripWord)
            .frame(minHeight: AceDesign.Size.tap)
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
            .opacity(enabled ? 1 : AceTheme.Opacity.disabled(scheme))
            .contentShape(Rectangle())
    }
}

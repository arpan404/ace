import SwiftUI

/// What floats over the transcript's end while the person reads away from it: a round glass
/// Scroll to end, centred above the composer.
struct ComposerFloaters: View {
    let behind: Bool
    let scrollToEnd: () -> Void
    var body: some View {
        HStack {
            if behind { ScrollToEndButton(action: scrollToEnd).transition(.opacity) }
        }
        .frame(maxWidth: .infinity)
        .animation(.default, value: behind)
    }
}

/// The thread's live state as one quiet line just above the capsule, on the field's left edge:
/// the status icon and one sentence from the daemon's whole-tree status ("Working for 4m 12s",
/// "Waiting on 2"), any other live part after it in muted words, and at most one text action on
/// the right ("2 queued", which opens the queue). No pill, no glass. Nothing when idle: the
/// bridge sends no pill then. Words, timer origins and what each part opens are the bridge's
/// (`PillRow`); which part is the action is `LiveLineParts`.
struct ComposerLiveLine: View {
    let pill: PillRow
    let open: (String) -> Void
    @State private var tapped = 0
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        let parts = LiveLineParts.of(pill)
        HStack(spacing: AceDesign.Space.related) {
            sentence(parts)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let action = parts.action {
                Button(action.label) { tapped += 1; open(action.opens) }
                    .buttonStyle(StripTextButtonStyle())
                    .monospacedDigit()
                    .fixedSize()
                    .accessibilityHint(Self.hint(action.opens))
                    .accessibilityIdentifier("pill.\(action.kind)")
            }
        }
        .padding(.leading, ComposerCapsuleMetrics.textEdge(sizeClass))
        .padding(.trailing, ComposerCapsuleMetrics.side(sizeClass))
        .frame(minHeight: AceDesign.Size.tap)
        .sensoryFeedback(.selection, trigger: tapped)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live")
        .accessibilityIdentifier("composer.live")
    }

    @ViewBuilder private func sentence(_ parts: LiveLineParts) -> some View {
        let words = LiveSentence(parts: parts)
        if parts.opens.isEmpty {
            words.accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
                .accessibilityIdentifier("pill.status")
        } else {
            Button { tapped += 1; open(parts.opens) } label: { words.tapBand(drawn: AceDesign.Size.chip) }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.updatesFrequently)
                .accessibilityHint(Self.hint(parts.opens))
                .accessibilityIdentifier(parts.status == nil ? "pill.\(parts.extras.first?.kind ?? "status")" : "pill.status")
        }
    }

    private static func hint(_ opens: String) -> String {
        switch opens {
        case "agents": "Opens the agent tree"
        case "queue": "Opens the queued messages"
        case "goal": "Opens the goal"
        default: ""
        }
    }
}

/// The line's sentence: the still status icon, the status words with their running time, then
/// the other live parts in muted words after a middle dot.
private struct LiveSentence: View {
    let parts: LiveLineParts
    var body: some View {
        HStack(spacing: AceDesign.Space.chipGap) {
            if let status = parts.status {
                glyph(status)
                StatusWords(status: status)
                    .layoutPriority(1)
            }
            ForEach(Array(parts.extras.enumerated()), id: \.element.id) { index, extra in
                if index > 0 || parts.status != nil {
                    Text(verbatim: "·").foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
                }
                Text(extra.label).monospacedDigit().foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .lineLimit(1)
        .contentShape(Rectangle())
    }
    /// The tone's still glyph; a working tree whose main agent only waits on others shows the
    /// subagents' mark.
    private func glyph(_ status: PillRow.Status) -> some View {
        let tone = AceTone(status.tone)
        let state: GlyphState = tone == .working && !status.live && status.opens == "agents" ? .subagents : GlyphState(tone: tone)
        return StatusGlyph(state, tone: tone)
    }
}

/// The status words with their running time. Needs-you is always strong (DESIGN.md §5): its
/// words in its status colour; the rest in the line's muted ink.
private struct StatusWords: View {
    let status: PillRow.Status
    var body: some View {
        Group {
            if let since = status.since, !status.lead.isEmpty {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text("\(status.lead) \(Elapsed.words(since: since, now: context.date))").monospacedDigit()
                }
            } else if !status.code.isEmpty {
                HStack(spacing: AceDesign.Space.tight) {
                    Text(status.label)
                    Text(status.code).aceMonospace(AceDesign.TextRole.code, relativeTo: .footnote).truncationMode(.middle)
                }
            } else {
                Text(status.label)
            }
        }
        .foregroundStyle(status.tone == "needs-you" ? AceTheme.StatusText.needsYou : AceTheme.Colours.mutedForeground)
    }
}

/// Back to the live end: a round glass button with a down caret.
struct ScrollToEndButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            AceIcon(.caretDown, size: AceDesign.Size.icon, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: AceDesign.Size.chip, height: AceDesign.Size.chip)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Circle(), interactive: true)
        .accessibilityLabel("Scroll to end")
        .accessibilityIdentifier("transcript.latest")
    }
}

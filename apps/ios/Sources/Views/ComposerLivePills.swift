import SwiftUI

/// What floats over the transcript's end while the person reads away from it: a round glass
/// Scroll to end, centred above the composer's foot. It sits over the foot rather than in it, so
/// showing it never changes the room the transcript keeps at its end.
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

/// The thread's live state as quiet pills just above the capsule, in one row that scrolls
/// sideways, starting at the field's left edge: the status first ("Working · 4m 12s", "Waiting on
/// 2"), then what else is live ("2 subagents", "1 command", "2 queued", "Pursuing goal"). Each is
/// a glass capsule floating over the transcript; colour only on its still icon. A pill that opens
/// something (the agent tree, the queue, the goal) is a button. Nothing when idle: the bridge
/// sends no pill then. Words, timer origins and what each opens are the bridge's (`PillRow`).
struct ComposerLivePills: View {
    let pill: PillRow
    let open: (String) -> Void
    @State private var tapped = 0
    @Environment(\.horizontalSizeClass) private var sizeClass
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: AceDesign.Space.chipGap) {
                ForEach(LivePill.of(pill)) { item in
                    pillButton(item).transition(.opacity)
                }
            }
            .padding(.leading, ComposerCapsuleMetrics.fieldEdge(sizeClass))
            .padding(.trailing, ComposerCapsuleMetrics.side(sizeClass))
            .animation(.default, value: LivePill.of(pill).map(\.id))
            // One glass container for the row, so neighbouring pills read as one material
            // rather than separate blurs, as the system draws grouped glass controls.
            .composerGlassGroup()
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .frame(minHeight: AceDesign.Size.tap)
        .sensoryFeedback(.selection, trigger: tapped)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live")
        .accessibilityIdentifier("composer.live")
    }

    @ViewBuilder private func pillButton(_ item: LivePill) -> some View {
        let identifier = "pill.\(item.id)"
        if item.opens.isEmpty {
            LivePillLabel(item: item)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.updatesFrequently)
                .accessibilityIdentifier(identifier)
        } else {
            Button { tapped += 1; open(item.opens) } label: {
                LivePillLabel(item: item).tapBand(drawn: AceDesign.Size.chip)
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(.updatesFrequently)
            .accessibilityHint(Self.hint(item.opens))
            .accessibilityIdentifier(identifier)
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

/// One pill: its still icon in the state's colour, then its words, on glass.
private struct LivePillLabel: View {
    let item: LivePill
    var body: some View {
        HStack(spacing: AceDesign.Space.chipGap) {
            mark
            switch item.part {
            case .status(let status):
                StatusWords(status: status)
            case .segment(let segment):
                SegmentWords(segment: segment)
            }
        }
        .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
        .lineLimit(1)
        .padding(.horizontal, AceDesign.Space.chip)
        .frame(height: AceDesign.Size.chip)
        .aceGlass(in: AceDesign.Shape.control)
        .contentShape(AceDesign.Shape.control)
    }

    @ViewBuilder private var mark: some View {
        switch item.part {
        case .status(let status):
            let tone = AceTone(status.tone)
            // A working tree whose main agent only waits on others shows the subagents' mark.
            let state: GlyphState = tone == .working && !status.live && status.opens == "agents" ? .subagents : GlyphState(tone: tone)
            StatusGlyph(state, tone: tone)
        case .segment(let segment):
            switch segment.kind {
            case "subagents": StatusGlyph(.subagents, tone: .working)
            case "commands": StatusGlyph(.background, tone: .background)
            case "queue": StatusGlyph(.queued, tone: .waiting)
            case "goal":
                AceIcon(.target, size: AceDesign.Size.glyphSmall, relativeTo: .caption)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityHidden(true)
            default: EmptyView()
            }
        }
    }
}

/// A part's words in muted ink; a goal's progress follows its state after a middle dot, quieter
/// still, as the web's goal strip reads ("Pursuing goal · 182K tokens · 3 checks").
private struct SegmentWords: View {
    let segment: PillRow.Segment
    var body: some View {
        if let detail = segment.detail, !detail.isEmpty {
            (Text(segment.label).foregroundStyle(AceDesign.Ink.muted)
                + Text(verbatim: " · \(detail)").foregroundStyle(AceDesign.Ink.subtle))
                .monospacedDigit()
        } else {
            Text(segment.label).monospacedDigit().foregroundStyle(AceDesign.Ink.muted)
        }
    }
}

/// The status words: the state, then its running time after a middle dot ("Working · 4m 12s"),
/// or a single background command in mono. Full ink: the pill's own fact.
private struct StatusWords: View {
    let status: PillRow.Status
    var body: some View {
        Group {
            if let since = status.since, !status.label.isEmpty {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(verbatim: "\(status.label) · \(Elapsed.words(since: since, now: context.date))").monospacedDigit()
                }
            } else if !status.code.isEmpty {
                HStack(spacing: AceDesign.Space.tight) {
                    Text(status.label)
                    Text(status.code).aceMonospace(AceDesign.TextRole.code, relativeTo: .footnote)
                        .truncationMode(.middle)
                        .frame(maxWidth: AceDesign.Size.tap * 4, alignment: .leading)
                }
            } else {
                Text(status.label)
            }
        }
        .foregroundStyle(AceDesign.Ink.primary)
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
        .tapBand(drawn: AceDesign.Size.chip, width: AceDesign.Size.chip)
        .accessibilityLabel("Scroll to end")
        .accessibilityIdentifier("transcript.latest")
    }
}

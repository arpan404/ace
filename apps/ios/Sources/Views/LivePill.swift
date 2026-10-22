import SwiftUI

/// What floats just above the composer: the live pill (what the thread does now and what else is
/// live, each part opening what it names) and, while the person reads away from the end, a round
/// Scroll to end beside it. Both are the composer's glass. Words, timer origins and what each part
/// opens are the bridge's (`PillRow`); this only draws them.
struct ComposerFloaters: View {
    let pill: PillRow?
    let behind: Bool
    let open: (String) -> Void
    let scrollToEnd: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            if let pill { LivePillCapsule(pill: pill, open: open).transition(arrival) }
            if behind { ScrollToEndButton(action: scrollToEnd).transition(arrival) }
        }
        .frame(maxWidth: .infinity)
        .animation(reduceMotion ? nil : AceTheme.Motion.spring, value: pill)
        .animation(reduceMotion ? nil : AceTheme.Motion.standardCurve, value: behind)
    }
    /// Things arrive; they don't fly: a fade, with a slight scale unless motion is reduced.
    private var arrival: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.94))
    }
}

/// One glass capsule: the status first ("Working for 1m 14s", sweeping while the main agent works),
/// then each other live thing ("2 subagents", "1 command", "2 queued", "Pursuing goal") after a
/// hairline. A part that opens something is its own button.
struct LivePillCapsule: View {
    let pill: PillRow
    let open: (String) -> Void
    @State private var tapped = 0
    var body: some View {
        HStack(spacing: AceTheme.Spacing.none) {
            if let status = pill.status {
                // At large text sizes the other parts give way first: the status always reads.
                part(opens: status.opens, label: status.label) { StatusWords(status: status) }
                    .layoutPriority(1)
                    .accessibilityAddTraits(.updatesFrequently)
                    .accessibilityIdentifier("pill.status")
            }
            ForEach(Array(pill.segments.enumerated()), id: \.element.id) { index, segment in
                if index > 0 || pill.status != nil { divider }
                part(opens: segment.opens, label: segment.label) { SegmentWords(segment: segment) }
                    .accessibilityIdentifier("pill.\(segment.kind)")
            }
        }
        .padding(.horizontal, AceTheme.Spacing.xs)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, AceTheme.Spacing.md)
        .aceGlass(in: AceShape.capsule, interactive: true)
        .sensoryFeedback(.selection, trigger: tapped)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Live")
        .accessibilityIdentifier("thread.pill")
    }
    static let height = AceTheme.Dimensions.touchTarget - AceTheme.Spacing.sm
    private var divider: some View {
        Rectangle().fill(AceTheme.Colours.separator)
            .frame(width: AceTheme.Dimensions.border, height: AceTheme.Spacing.lg)
            .accessibilityHidden(true)
    }
    @ViewBuilder private func part<Words: View>(opens: String, label: String, @ViewBuilder words: () -> Words) -> some View {
        let content = words()
            .lineLimit(1)
            .padding(.horizontal, AceTheme.Spacing.md - AceTheme.Spacing.xxs)
            // Each part as tall as the pill (taller with large text), never the space around it.
            .frame(minHeight: Self.height)
            .contentShape(Rectangle())
        if opens.isEmpty {
            content.accessibilityElement(children: .combine)
        } else {
            Button { tapped += 1; open(opens) } label: { content }
                .buttonStyle(PillPartStyle())
                .accessibilityHint(Self.hint(opens))
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

/// The status part: the working ring while it moves, then the words with their running time.
private struct StatusWords: View {
    let status: PillRow.Status
    var body: some View {
        let needsYou = status.tone == "needs-you"
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if needsYou { StatusGlyph(.needsYou, tone: .needsYou) }
            else if status.live { StatusGlyph(.working, tone: .working, live: true) }
            words.shimmer(status.live)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).fontWeight(.medium)
        // Needs-you is always strong (DESIGN.md §5): its word in its status colour.
        .foregroundStyle(needsYou ? AceTheme.StatusText.needsYou : AceTheme.Colours.foreground)
    }
    @ViewBuilder private var words: some View {
        if let since = status.since, !status.lead.isEmpty {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text("\(status.lead) \(Elapsed.words(since: since, now: context.date))").monospacedDigit()
            }
        } else if !status.code.isEmpty {
            HStack(spacing: AceTheme.Spacing.xs) {
                Text(status.label)
                Text(status.code).aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote).truncationMode(.middle)
            }
        } else {
            Text(status.label)
        }
    }
}

/// A part after the status: muted words; the goal keeps its target mark.
private struct SegmentWords: View {
    let segment: PillRow.Segment
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            if segment.kind == "goal" { AceIcon(.target, size: 13, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground) }
            Text(segment.label).monospacedDigit().shimmer(segment.live)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
    }
}

/// A pill part pressed: a step brighter on its own capsule wash.
private struct PillPartStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AceTheme.Colours.fill : .clear, in: AceShape.capsule)
    }
}

/// Back to the live end: a round glass button with a down caret, beside the pill.
struct ScrollToEndButton: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            AceIcon(.caretDown, size: 16, weight: .bold, relativeTo: .body)
                .foregroundStyle(AceTheme.Colours.foreground)
                .frame(width: LivePillCapsule.height, height: LivePillCapsule.height)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .aceGlass(in: Circle(), interactive: true)
        .accessibilityLabel("Scroll to end")
        .accessibilityIdentifier("transcript.latest")
    }
}

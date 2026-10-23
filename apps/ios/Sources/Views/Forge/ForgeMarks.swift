import SwiftUI

/// A GitHub label in its own colour, as the web's pill draws it: a fifth of the colour behind,
/// a stronger edge, and the name mixed toward the page's ink so it reads in either appearance.
/// Labels are the one place a non-status hue appears (DESIGN.md allows GitHub's colours). A
/// capsule, like every iOS 26 control and pill.
struct ForgeLabelPill: View {
    let label: ForgeLabel

    private var hue: Color? { label.color.map { Color(uiColor: UIColor(hex: $0)) } }

    var body: some View {
        Text(label.name)
            .font(.system(size: 11, weight: .medium))
            .lineLimit(1)
            .padding(.horizontal, 7)
            .frame(height: 18)
            .foregroundStyle(hue.map { $0.mix(with: AceTheme.Colours.foreground, by: 0.45) } ?? AceTheme.Colours.mutedForeground)
            .background(AceShape.capsule.fill(hue?.opacity(0.2) ?? .clear))
            .overlay(AceShape.capsule.strokeBorder(hue?.opacity(0.45) ?? AceTheme.Colours.separator, lineWidth: 1))
            .accessibilityLabel("Label \(label.name)")
    }
}

/// Up to `limit` pills on one line, the rest as "+N".
struct ForgeLabels: View {
    let labels: [ForgeLabel]
    var limit = 3
    var body: some View {
        if !labels.isEmpty {
            HStack(spacing: AceTheme.Spacing.xs) {
                ForEach(labels.prefix(limit), id: \.self) { ForgeLabelPill(label: $0) }
                if labels.count > limit {
                    Text("+\(labels.count - limit)").meta(AceTheme.Colours.subtleForeground).monospacedDigit()
                }
            }
        }
    }
}

/// The pull request's state glyph in its hue, with a red dot when it conflicts with its base.
struct ForgePullGlyph: View {
    let state: ForgeMark
    let merged: Bool
    var conflicting = false
    var size: CGFloat = 16

    var body: some View {
        AceIcon(merged ? .gitMerge : .gitPullRequest, size: size, relativeTo: .body)
            .foregroundStyle(AceTone(state.tone).mark)
            .overlay(alignment: .bottomTrailing) {
                if conflicting {
                    Circle().fill(AceTone.failed.mark).frame(width: 7, height: 7)
                        .overlay(Circle().stroke(AceTheme.Colours.background, lineWidth: 1.5))
                        .offset(x: 2, y: 2)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(conflicting ? "\(state.word), conflicts with base" : state.word)
    }
}

/// An issue's state glyph: open green, closed in the merged hue.
struct ForgeIssueGlyph: View {
    let state: ForgeMark
    var size: CGFloat = 16
    var body: some View {
        AceIcon(state.tone == "done" ? .record : .checkCircle, size: size, relativeTo: .body)
            .foregroundStyle(AceTone(state.tone).mark)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(state.word)
    }
}

/// A review or checks mark: its glyph in its tone (neutral ink when idle), its word for
/// VoiceOver.
struct ForgeStateMark: View {
    enum Kind { case review, checks }
    let kind: Kind
    let mark: ForgeMark

    private var icon: AceIcon.Name {
        switch (kind, mark.tone) {
        case (.review, "done"): .checkCircle
        case (.review, "failed"): .xCircle
        case (.review, _): .circleDashed
        case (.checks, "done"): .check
        case (.checks, "failed"): .x
        default: .clock
        }
    }

    var body: some View {
        AceIcon(icon, size: 14, weight: kind == .checks && mark.tone != "working" ? .bold : .regular, relativeTo: .footnote)
            .foregroundStyle(mark.tone == "idle" ? AceTheme.Colours.mutedForeground : AceTone(mark.tone).mark)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(mark.word)
    }
}

/// A group of rows: its name and GitHub's total once known (DESIGN.md: quiet section label).
struct ForgeGroupHeader: View {
    let label: String
    let count: Int?
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xs) {
            Text(label).fontWeight(.medium)
            if let count { Text(count.formatted()).monospacedDigit().foregroundStyle(AceTheme.Colours.subtleForeground) }
            Spacer(minLength: AceTheme.Spacing.none)
        }
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .foregroundStyle(AceTheme.Colours.mutedForeground)
        .padding(.horizontal, AceTheme.Spacing.md)
        .padding(.top, AceTheme.Spacing.md)
        .padding(.bottom, AceTheme.Spacing.xxs)
        .accessibilityAddTraits(.isHeader)
    }
}

/// "+24 −6", added in the done hue and removed in the failed hue, as the web's lists show it.
struct ForgeDiffStat: View {
    let additions: Int
    let deletions: Int
    var body: some View {
        HStack(spacing: AceTheme.Spacing.xxs) {
            Text(verbatim: "+\(additions)").foregroundStyle(AceTone.done.text)
            Text(verbatim: "−\(deletions)").foregroundStyle(AceTone.failed.text)
        }
        .monospacedDigit()
        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(additions) lines added, \(deletions) removed")
    }
}

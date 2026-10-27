import SwiftUI

/// Usage per model or per day, largest first, each line's share drawn as a hairline bar in the
/// provider's hue. On Cost, models ace has no price for fold into one quiet line at the end.
struct UsageBreakdown: View {
    private enum Group: Hashable { case model, day }
    let view: UsageMetricView
    @State private var group = Group.model
    @State private var showUnpriced = false

    private var lines: [UsageMetricView.Line] {
        switch group {
        case .model: view.byModel + (showUnpriced ? view.unpriced?.lines ?? [] : [])
        case .day: view.byDay
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            HStack(alignment: .center) {
                UsageSectionHeading(title: "Breakdown")
                Spacer(minLength: AceTheme.Spacing.md)
                Picker("Break down by", selection: $group) {
                    Text("Model").tag(Group.model)
                    Text("Day").tag(Group.day)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .padding(.bottom, AceTheme.Spacing.sm)
                .accessibilityIdentifier("usage.breakdown")
            }
            if lines.isEmpty {
                Hairline()
                Text("No usage in this range")
                    .aceFont(InsetStyle.value, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, AceTheme.Spacing.xl)
            }
            ForEach(Array(lines.enumerated()), id: \.element.key) { index, line in
                Hairline()
                UsageBreakdownRow(rank: index + 1, line: line)
            }
            if group == .model, let unpriced = view.unpriced {
                Hairline()
                Button {
                    withAnimation(AceTheme.Motion.standardCurve) { showUnpriced.toggle() }
                } label: {
                    Text("\(showUnpriced ? "Hide" : "Show") \(unpriced.label)")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.mutedForeground)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, AceTheme.Spacing.md)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(showUnpriced ? "Shown" : "Hidden")
            }
        }
    }
}

private struct UsageBreakdownRow: View {
    let rank: Int
    let line: UsageMetricView.Line
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Text("\(rank)").monospacedDigit()
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
                .frame(minWidth: 18, alignment: .leading)
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    if let provider = line.provider { ProviderMark(provider: provider, size: 15) }
                    Text(line.name).aceFont(InsetStyle.label, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Text(line.figure).aceFont(InsetStyle.label, relativeTo: .body).monospacedDigit()
                        .foregroundStyle(line.figure == "Unpriced" ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
                }
                GeometryReader { box in
                    Capsule().fill(UsageColour.of(line.hue, ink: line.ink))
                        .frame(width: max(2, box.size.width * min(1, line.fraction)))
                }
                .frame(height: 2)
                .accessibilityHidden(true)
                HStack {
                    Text(line.share).monospacedDigit()
                    Spacer(minLength: AceTheme.Spacing.sm)
                    Text(line.other).monospacedDigit()
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
        .padding(.vertical, AceTheme.Spacing.md)
        .accessibilityElement(children: .combine)
    }
}

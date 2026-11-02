import SwiftUI

/// Usage per model or per day, largest first, each line's share drawn as a hairline bar in the
/// provider's hue. On Cost, models ace has no price for fold into one quiet line at the end.
struct UsageBreakdown: View {
    @Environment(\.aceReduceMotion) private var reduceMotion
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
                Spacer(minLength: AceDesign.Space.row)
                Picker("Break down by", selection: $group) {
                    Text("Model").tag(Group.model)
                    Text("Day").tag(Group.day)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                .padding(.bottom, AceDesign.Space.related)
                .accessibilityIdentifier("usage.breakdown")
            }
            if lines.isEmpty {
                Hairline()
                EmptyState(systemImage: "chart.bar", title: "No usage in this range")
                    .padding(.vertical, AceDesign.Space.group)
            }
            ForEach(Array(lines.enumerated()), id: \.element.key) { index, line in
                Hairline()
                UsageBreakdownRow(rank: index + 1, line: line)
            }
            if group == .model, let unpriced = view.unpriced {
                Hairline()
                Button {
                    withAnimation(AceDesign.Motion.arriving(reduceMotion)) { showUnpriced.toggle() }
                } label: {
                    Text("\(showUnpriced ? "Hide" : "Show") \(unpriced.label)")
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, AceDesign.Space.row)
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
    /// Room for a two-digit rank, and the share bar's hairline thickness: the row's own drawing.
    private static let rankWidth: CGFloat = 18
    private static let barHeight: CGFloat = 2
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Text("\(rank)").monospacedDigit()
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
                .frame(minWidth: Self.rankWidth, alignment: .leading)
            VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                HStack(spacing: AceDesign.Space.related) {
                    if let provider = line.provider { ProviderMark(provider: provider, size: AceDesign.Size.icon) }
                    Text(line.name).font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: AceDesign.Space.related)
                    Text(line.figure).font(AceDesign.Typeface.body).monospacedDigit()
                        .foregroundStyle(line.figure == "Unpriced" ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                }
                GeometryReader { box in
                    Capsule().fill(UsageColour.of(line.hue, ink: line.ink))
                        .frame(width: max(Self.barHeight, box.size.width * min(1, line.fraction)))
                }
                .frame(height: Self.barHeight)
                .accessibilityHidden(true)
                HStack {
                    Text(line.share).monospacedDigit()
                    Spacer(minLength: AceDesign.Space.related)
                    Text(line.other).monospacedDigit()
                }
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
            }
        }
        .padding(.vertical, AceDesign.Space.row)
        .accessibilityElement(children: .combine)
    }
}

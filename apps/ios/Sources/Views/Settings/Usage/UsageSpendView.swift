import SwiftUI

/// Tokens or money over the range, as the web Usage page shows it: the total with its growth,
/// each provider, each day, the totals, each type and each model or day. Headings and hairline
/// rows on the page, never boxed cards.
struct UsageSpendView: View {
    let view: UsageMetricView
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxxl) {
            headline
            if !view.providers.isEmpty { providers }
            UsageDailyChart(chart: view.chart)
            totals
            UsageTypeBar(types: view.types)
            UsageBreakdown(view: view)
            if let note = view.note {
                Text(note).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(view.total)
                .font(.system(size: 40, weight: .medium, design: .default)).monospacedDigit()
                .foregroundStyle(AceTheme.Colours.foreground)
                .contentTransition(.numericText())
                .accessibilityIdentifier("usage.total")
            HStack(spacing: AceTheme.Spacing.xs) {
                if !view.growth.label.isEmpty {
                    UsageGrowthText(growth: view.growth)
                    Text(view.basis).foregroundStyle(AceTheme.Colours.subtleForeground)
                    Text("·").foregroundStyle(AceTheme.Colours.subtleForeground).accessibilityHidden(true)
                }
                Text(view.sessions).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .lineLimit(1).minimumScaleFactor(0.85)
        }
        .accessibilityElement(children: .combine)
    }

    private var providers: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            UsageSectionHeading(title: "By provider")
            ForEach(view.providers) { line in
                Hairline()
                UsageProviderRow(line: line)
            }
        }
    }

    private var totals: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            UsageSectionHeading(title: "Totals")
            ForEach(view.totals, id: \.label) { stat in
                Hairline()
                HStack {
                    Text(stat.label).foregroundStyle(AceTheme.Colours.mutedForeground)
                    Spacer(minLength: AceTheme.Spacing.md)
                    Text(stat.value).monospacedDigit().foregroundStyle(AceTheme.Colours.foreground)
                }
                .aceFont(InsetStyle.value, relativeTo: .body)
                .padding(.vertical, AceTheme.Spacing.md)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// "Daily cost", "Totals": a section's heading on the Usage page.
struct UsageSectionHeading: View {
    let title: String
    var body: some View {
        Text(title).aceFont(InsetStyle.header, relativeTo: .subheadline)
            .foregroundStyle(AceTheme.Colours.mutedForeground)
            .padding(.bottom, AceTheme.Spacing.sm)
            .accessibilityAddTraits(.isHeader)
    }
}

/// "+12%": growth is information, not attention, so it stays in the muted ink either way.
struct UsageGrowthText: View {
    let growth: UsageGrowth
    var body: some View {
        Text(growth.label).monospacedDigit()
            .foregroundStyle(growth.direction == "flat" ? AceTheme.Colours.subtleForeground : AceTheme.Colours.foreground)
    }
}

private struct UsageProviderRow: View {
    let line: UsageMetricView.ProviderLine
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm) {
            Circle().fill(UsageColour.of(line.hue, ink: line.ink)).frame(width: 8, height: 8)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceTheme.Spacing.sm) {
                    ProviderMark(provider: line.id, size: 15)
                    Text(line.name).aceFont(InsetStyle.label, relativeTo: .body)
                        .foregroundStyle(AceTheme.Colours.foreground).lineLimit(1)
                    Text(line.sessions).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1)
                }
                Text(line.detail).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground).lineLimit(1).minimumScaleFactor(0.85)
            }
            Spacer(minLength: AceTheme.Spacing.sm)
            VStack(alignment: .trailing, spacing: AceTheme.Spacing.xxs) {
                Text(line.figure).aceFont(InsetStyle.label, relativeTo: .body).monospacedDigit()
                    .foregroundStyle(AceTheme.Colours.foreground)
                if !line.growth.label.isEmpty {
                    UsageGrowthText(growth: line.growth)
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                }
            }
        }
        .padding(.vertical, AceTheme.Spacing.md)
        .accessibilityElement(children: .combine)
    }
}

/// Input, cache read, cache write and output as one capsule bar with its legend beneath.
struct UsageTypeBar: View {
    let types: UsageMetricView.Types
    private static let tones: [Double] = [0.45, 0.25, 0.65, 1]
    private var total: Double { types.parts.reduce(0) { $0 + $1.value } }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            UsageSectionHeading(title: types.title)
            GeometryReader { box in
                HStack(spacing: AceTheme.Spacing.xxs) {
                    if total > 0 {
                        ForEach(Array(types.parts.enumerated()), id: \.offset) { index, part in
                            Capsule().fill(tone(index))
                                .frame(width: max(0, (box.size.width - AceTheme.Spacing.xxs * 3) * part.value / total))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AceTheme.Colours.fill, in: Capsule())
                .clipShape(Capsule())
            }
            .frame(height: 8)
            .padding(.bottom, AceTheme.Spacing.sm)
            .accessibilityHidden(true)
            ForEach(Array(types.parts.enumerated()), id: \.offset) { index, part in
                Hairline()
                HStack(spacing: AceTheme.Spacing.sm) {
                    RoundedRectangle(cornerRadius: 2, style: .continuous).fill(tone(index)).frame(width: 8, height: 8)
                    Text(part.label).foregroundStyle(AceTheme.Colours.mutedForeground)
                    Spacer(minLength: AceTheme.Spacing.md)
                    Text(part.text).monospacedDigit().foregroundStyle(AceTheme.Colours.foreground)
                }
                .aceFont(InsetStyle.value, relativeTo: .body)
                .padding(.vertical, AceTheme.Spacing.md)
                .accessibilityElement(children: .combine)
            }
        }
    }
    private func tone(_ index: Int) -> Color {
        let opacity = Self.tones[min(index, Self.tones.count - 1)]
        return opacity >= 1 ? AceTheme.Colours.foreground : AceTheme.Colours.mutedForeground.opacity(opacity)
    }
}

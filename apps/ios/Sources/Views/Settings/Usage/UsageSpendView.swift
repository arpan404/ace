import SwiftUI

/// Tokens or money over the range, as the web Usage page shows it: the total with its growth,
/// each provider, each day, the totals, each type and each model or day. Headings and hairline
/// rows on the page, never boxed cards.
struct UsageSpendView: View {
    let view: UsageMetricView
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.section) {
            headline
            if !view.providers.isEmpty { providers }
            UsageDailyChart(chart: view.chart)
            totals
            UsageTypeBar(types: view.types)
            UsageBreakdown(view: view)
            if let note = view.note {
                Text(note).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
            }
        }
    }

    private var headline: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
            Text(view.total)
                .font(AceDesign.Typeface.largeTitle).monospacedDigit()
                .foregroundStyle(AceDesign.Ink.primary)
                .contentTransition(.numericText())
                .accessibilityIdentifier("usage.total")
            HStack(spacing: AceDesign.Space.tight) {
                if !view.growth.label.isEmpty {
                    UsageGrowthText(growth: view.growth)
                    Text(view.basis).foregroundStyle(AceDesign.Ink.subtle)
                    Text("·").foregroundStyle(AceDesign.Ink.subtle).accessibilityHidden(true)
                }
                Text(view.sessions).foregroundStyle(AceDesign.Ink.muted)
            }
            .font(AceDesign.Typeface.meta)
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
                    Text(stat.label).foregroundStyle(AceDesign.Ink.muted)
                    Spacer(minLength: AceDesign.Space.row)
                    Text(stat.value).monospacedDigit().foregroundStyle(AceDesign.Ink.primary)
                }
                .font(AceDesign.Typeface.body)
                .padding(.vertical, AceDesign.Space.row)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

/// "Daily cost", "Totals": a section's heading on the Usage page.
struct UsageSectionHeading: View {
    let title: String
    var body: some View {
        Text(title).font(AceDesign.Typeface.meta)
            .foregroundStyle(AceDesign.Ink.muted)
            .padding(.bottom, AceDesign.Space.related)
            .accessibilityAddTraits(.isHeader)
    }
}

/// "+12%": growth is information, not attention, so it stays in the muted ink either way.
struct UsageGrowthText: View {
    let growth: UsageGrowth
    var body: some View {
        Text(growth.label).monospacedDigit()
            .foregroundStyle(growth.direction == "flat" ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
    }
}

private struct UsageProviderRow: View {
    let line: UsageMetricView.ProviderLine
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.related) {
            Circle().fill(UsageColour.of(line.hue, ink: line.ink)).frame(width: AceDesign.Size.legendDot, height: AceDesign.Size.legendDot)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                HStack(spacing: AceDesign.Space.related) {
                    ProviderMark(provider: line.id, size: AceDesign.Size.icon)
                    Text(line.name).font(AceDesign.Typeface.body)
                        .foregroundStyle(AceDesign.Ink.primary).lineLimit(1)
                    Text(line.sessions).font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1)
                }
                Text(line.detail).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle).lineLimit(1).minimumScaleFactor(0.85)
            }
            Spacer(minLength: AceDesign.Space.related)
            VStack(alignment: .trailing, spacing: AceTheme.Spacing.xxs) {
                Text(line.figure).font(AceDesign.Typeface.body).monospacedDigit()
                    .foregroundStyle(AceDesign.Ink.primary)
                if !line.growth.label.isEmpty {
                    UsageGrowthText(growth: line.growth)
                        .font(AceDesign.Typeface.meta)
                }
            }
        }
        .padding(.vertical, AceDesign.Space.row)
        .accessibilityElement(children: .combine)
    }
}

/// Input, cache read, cache write and output as one capsule bar with its legend beneath.
struct UsageTypeBar: View {
    let types: UsageMetricView.Types
    /// One ink in four strengths, one per token type: the chart's own shading.
    private static let tones: [Double] = [0.45, 0.25, 0.65, 1]
    private var total: Double { types.parts.reduce(0) { $0 + $1.value } }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
            UsageSectionHeading(title: types.title)
            GeometryReader { box in
                HStack(spacing: AceTheme.Spacing.xxs) {
                    if total > 0 {
                        ForEach(Array(types.parts.enumerated()), id: \.offset) { index, part in
                            AceDesign.Shape.control.fill(tone(index))
                                .frame(width: max(0, (box.size.width - AceTheme.Spacing.xxs * 3) * part.value / total))
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(AceDesign.Surface.fill, in: AceDesign.Shape.control)
                .clipShape(AceDesign.Shape.control)
            }
            .frame(height: AceDesign.Size.legendDot)
            .padding(.bottom, AceDesign.Space.related)
            .accessibilityHidden(true)
            ForEach(Array(types.parts.enumerated()), id: \.offset) { index, part in
                Hairline()
                HStack(spacing: AceDesign.Space.related) {
                    AceDesign.Shape.control.fill(tone(index)).frame(width: AceDesign.Size.legendDot, height: AceDesign.Size.legendDot)
                    Text(part.label).foregroundStyle(AceDesign.Ink.muted)
                    Spacer(minLength: AceDesign.Space.row)
                    Text(part.text).monospacedDigit().foregroundStyle(AceDesign.Ink.primary)
                }
                .font(AceDesign.Typeface.body)
                .padding(.vertical, AceDesign.Space.row)
                .accessibilityElement(children: .combine)
            }
        }
    }
    private func tone(_ index: Int) -> Color {
        let opacity = Self.tones[min(index, Self.tones.count - 1)]
        return opacity >= 1 ? AceDesign.Ink.primary : AceDesign.Ink.muted.opacity(opacity)
    }
}

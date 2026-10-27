import Charts
import SwiftUI

/// A day-by-day line per provider in the provider's hue, as the web Usage page draws it. Touching
/// the chart picks a day and shows its figures; assistive tech hears the peak day.
struct UsageDailyChart: View {
    let chart: UsageMetricView.Chart
    @State private var picked: Int?

    private struct Point: Identifiable {
        let id: String
        let series: Int
        let index: Int
        let value: Double
    }
    private var points: [Point] {
        chart.days.enumerated().flatMap { index, day in
            chart.series.indices.map { series in
                Point(id: "\(series):\(index)", series: series, index: index, value: day.values[safe: series] ?? 0)
            }
        }
    }
    private var xTicks: [Int] {
        let count = chart.days.count
        return count > 2 ? [0, (count - 1) / 2, count - 1] : Array(0..<count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            UsageSectionHeading(title: chart.title)
            readout
            plot
                .frame(height: 176)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chart.summary)
        }
    }

    /// The picked day's figures, or the series' names when none is picked: the chart's legend.
    @ViewBuilder private var readout: some View {
        let day = picked.flatMap { chart.days[safe: $0] }
        ViewThatFits(in: .horizontal) {
            readoutLine(day: day, axis: .horizontal)
            readoutLine(day: day, axis: .vertical)
        }
        .frame(minHeight: 20, alignment: .leading)
    }

    private func readoutLine(day: UsageMetricView.Chart.Day?, axis: Axis) -> some View {
        let layout = axis == .horizontal
            ? AnyLayout(HStackLayout(spacing: AceTheme.Spacing.md))
            : AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
        return layout {
            if let day {
                Text(day.title).aceFont(AceTheme.Typography.label, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.foreground)
            }
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                HStack(spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
                    Circle().fill(UsageColour.of(series.hue, ink: series.ink)).frame(width: 7, height: 7)
                    Text(series.name).foregroundStyle(AceTheme.Colours.mutedForeground)
                    if let day {
                        Text(day.texts[safe: index] ?? "").monospacedDigit().foregroundStyle(AceTheme.Colours.foreground)
                    }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                .lineLimit(1)
            }
        }
    }

    private var plot: some View {
        Chart {
            lines
            selection
        }
        .chartLegend(.hidden)
        .chartXScale(domain: chart.days.count > 1 ? 0...(chart.days.count - 1) : -1...1)
        .chartYScale(domain: 0...chart.top)
        .chartXAxis { xAxis }
        .chartYAxis { yAxis }
        .chartXSelection(value: $picked)
        .sensoryFeedback(.selection, trigger: picked)
    }

    @ChartContentBuilder private var lines: some ChartContent {
        ForEach(points) { point in
            if chart.days.count > 1 {
                line(point)
            } else {
                dot(point, size: 36)
            }
        }
    }

    private func line(_ point: Point) -> some ChartContent {
        Charts.LineMark(x: .value("Day", point.index), y: .value("Value", point.value),
                 series: .value("Provider", point.series))
            .foregroundStyle(colour(point.series))
            .lineStyle(StrokeStyle(lineWidth: 1.75, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.monotone)
    }

    private func dot(_ point: Point, size: CGFloat) -> some ChartContent {
        PointMark(x: .value("Day", point.index), y: .value("Value", point.value))
            .foregroundStyle(colour(point.series))
            .symbolSize(size)
    }

    @ChartContentBuilder private var selection: some ChartContent {
        if let picked {
            RuleMark(x: .value("Day", picked))
                .foregroundStyle(AceTheme.Colours.separator)
                .lineStyle(StrokeStyle(lineWidth: 1))
            ForEach(points.filter { $0.index == picked }) { point in
                dot(point, size: 28)
            }
        }
    }

    private var xAxis: some AxisContent {
        AxisMarks(values: xTicks) { value in
            let index = value.as(Int.self) ?? 0
            AxisValueLabel(anchor: anchor(index)) {
                Text(chart.days[safe: index]?.label ?? "")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
    }

    private var yAxis: some AxisContent {
        AxisMarks(position: .leading, values: chart.axis.map(\.value)) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: AceTheme.Dimensions.border))
                .foregroundStyle(AceTheme.Colours.separator)
            AxisValueLabel {
                Text(label(value.as(Double.self) ?? 0)).monospacedDigit()
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption2)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
    }

    private func colour(_ series: Int) -> Color {
        let entry = chart.series[safe: series]
        return UsageColour.of(entry?.hue, ink: entry?.ink ?? true)
    }
    private func label(_ value: Double) -> String {
        chart.axis.min(by: { abs($0.value - value) < abs($1.value - value) })?.label ?? ""
    }
    /// The first and last day labels sit inside the plot instead of hanging past its edges.
    private func anchor(_ index: Int) -> UnitPoint {
        index == 0 ? .topLeading : index == chart.days.count - 1 && index > 0 ? .topTrailing : .top
    }
}

fileprivate extension Array {
    subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}

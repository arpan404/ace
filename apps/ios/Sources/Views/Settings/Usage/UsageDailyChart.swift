import Charts
import SwiftUI

/// A day-by-day line per provider in the provider's hue, as the web Usage page draws it. Touching
/// a day picks it and shows its figures, tapping it again lets it go; assistive tech hears the peak day.
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

    /// The chart's own drawing: the plot's height, the line and its dots, the pick rule, and the
    /// legend's line kept one line tall so picking a day never moves the plot.
    private static let plotHeight: CGFloat = 176
    private static let readoutHeight: CGFloat = 20
    private static let lineWidth: CGFloat = 1.75
    private static let ruleWidth: CGFloat = 1
    private static let loneDot: CGFloat = 36
    private static let pickedDot: CGFloat = 28

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            UsageSectionHeading(title: chart.title)
            readout
            plot
                .frame(height: Self.plotHeight)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(chart.summary)
        }
    }

    /// The picked day's figures, or the series' names when none is picked: the chart's legend.
    /// It stays one line so picking a day never moves the chart: with a day picked and no room
    /// for names, each figure keeps only its provider's dot (the rows above name them).
    @ViewBuilder private var readout: some View {
        let day = picked.flatMap { chart.days[safe: $0] }
        ViewThatFits(in: .horizontal) {
            readoutLine(day: day, names: true)
            readoutLine(day: day, names: false)
            readoutLine(day: day, names: false).minimumScaleFactor(0.7)
        }
        .frame(minHeight: Self.readoutHeight, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func readoutLine(day: UsageMetricView.Chart.Day?, names: Bool) -> some View {
        HStack(spacing: AceDesign.Space.row) {
            if let day {
                Text(day.title).font(AceDesign.Typeface.body)
                    .foregroundStyle(AceDesign.Ink.primary)
            }
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                HStack(spacing: AceDesign.Space.tight) {
                    Circle().fill(UsageColour.of(series.hue, ink: series.ink)).frame(width: AceDesign.Size.legendDot, height: AceDesign.Size.legendDot)
                    if names || day == nil {
                        Text(series.name).foregroundStyle(AceDesign.Ink.muted)
                    }
                    if let day {
                        Text(day.texts[safe: index] ?? "").monospacedDigit().foregroundStyle(AceDesign.Ink.primary)
                            .accessibilityLabel("\(series.name) \(day.texts[safe: index] ?? "")")
                    }
                }
                .font(AceDesign.Typeface.meta)
            }
        }
        .lineLimit(1)
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
        .chartGesture { proxy in
            SpatialTapGesture().onEnded { tap in
                let before = picked
                proxy.selectXValue(at: tap.location.x)
                if picked == before { picked = nil }
            }
        }
        .sensoryFeedback(.selection, trigger: picked)
    }

    @ChartContentBuilder private var lines: some ChartContent {
        ForEach(points) { point in
            if chart.days.count > 1 {
                line(point)
            } else {
                dot(point, size: Self.loneDot)
            }
        }
    }

    private func line(_ point: Point) -> some ChartContent {
        Charts.LineMark(x: .value("Day", point.index), y: .value("Value", point.value),
                 series: .value("Provider", point.series))
            .foregroundStyle(colour(point.series))
            .lineStyle(StrokeStyle(lineWidth: Self.lineWidth, lineCap: .round, lineJoin: .round))
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
                .lineStyle(StrokeStyle(lineWidth: Self.ruleWidth))
            ForEach(points.filter { $0.index == picked }) { point in
                dot(point, size: Self.pickedDot)
            }
        }
    }

    private var xAxis: some AxisContent {
        AxisMarks(values: xTicks) { value in
            let index = value.as(Int.self) ?? 0
            AxisValueLabel(anchor: anchor(index)) {
                Text(chart.days[safe: index]?.label ?? "")
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
            }
        }
    }

    private var yAxis: some AxisContent {
        AxisMarks(position: .leading, values: chart.axis.map(\.value)) { value in
            AxisGridLine(stroke: StrokeStyle(lineWidth: AceTheme.Dimensions.border))
                .foregroundStyle(AceTheme.Colours.separator)
            AxisValueLabel {
                Text(label(value.as(Double.self) ?? 0)).monospacedDigit()
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
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

import SwiftUI

/// The profile's year of work, as the web's Profile page shows it: five figures, the activity
/// grid, the most used providers and a few insights. Sections of the Profile page's list.
struct ProfileActivitySections: View {
    let report: ProfileReport?
    let problem: String?
    let retry: () -> Void

    var body: some View {
        Section {
            if let report {
                ForEach(report.highlights, id: \.label) { figure in
                    LabeledContent(figure.label) { Text(figure.value).monospacedDigit() }
                        .accessibilityIdentifier("profile.highlight")
                }
            } else if let problem {
                ServiceProblem(message: problem)
                Button("Try again", action: retry).buttonStyle(.textAction())
            } else {
                SkeletonRows(count: 2, label: "Loading activity", retry: retry)
                    .listRowInsets(EdgeInsets())
            }
        } header: {
            InsetHeader("Activity")
        } footer: {
            if let report { Text([report.span, report.coverage].compactMap(\.self).joined(separator: " · ")) }
        }
        .insetRowBackground()

        if let report {
            Section {
                if report.empty {
                    Text("Your agents' work shows here as they run.")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceDesign.Ink.muted)
                        .accessibilityIdentifier("profile.empty")
                } else {
                    ActivityGrid(weeks: report.weeks, months: report.months)
                }
            }
            .insetRowBackground()

            if !report.providers.isEmpty {
                Section {
                    ForEach(report.providers, id: \.name) { provider in
                        LabeledContent(provider.name) { Text("\(provider.percent)%").monospacedDigit() }
                    }
                } header: { InsetHeader("Most used providers") }
                .insetRowBackground()
            }
            if !report.insights.isEmpty {
                Section {
                    ForEach(report.insights, id: \.label) { figure in
                        LabeledContent(figure.label) { Text(figure.value).lineLimit(1) }
                    }
                } header: { InsetHeader("Insights") }
                .insetRowBackground()
            }
        }
    }
}

/// A year of days, one column per week, Sunday at the top, darker for busier days. Scrolls
/// sideways and opens on the latest weeks.
private struct ActivityGrid: View {
    let weeks: [[Int]]
    let months: [ProfileReport.Month]
    private let cell: CGFloat = 11
    private let gap: CGFloat = 3

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: AceDesign.Space.tight) {
                ZStack(alignment: .leading) {
                    ForEach(months, id: \.week) { month in
                        Text(month.label)
                            .aceFont(AceTheme.Typography.caption, relativeTo: .caption2)
                            .foregroundStyle(AceDesign.Ink.subtle)
                            .offset(x: CGFloat(month.week) * (cell + gap))
                    }
                }
                .frame(height: 14, alignment: .leading)
                HStack(alignment: .top, spacing: gap) {
                    ForEach(weeks.indices, id: \.self) { week in
                        VStack(spacing: gap) {
                            ForEach(weeks[week].indices, id: \.self) { day in
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(colour(weeks[week][day]))
                                    .frame(width: cell, height: cell)
                            }
                        }
                    }
                }
            }
            .padding(.vertical, AceDesign.Space.tight)
        }
        .defaultScrollAnchor(.trailing)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Activity over the last 12 months")
        .accessibilityValue(summary)
        .accessibilityIdentifier("profile.grid")
    }

    /// No work, then busier days in four steps of the one accent; days outside the year are gaps.
    private func colour(_ level: Int) -> Color {
        switch level {
        case ..<0: .clear
        case 0: AceTheme.Colours.fill
        case 1: AceDesign.Ink.accent.opacity(0.25)
        case 2: AceDesign.Ink.accent.opacity(0.45)
        case 3: AceDesign.Ink.accent.opacity(0.7)
        default: AceDesign.Ink.accent
        }
    }

    private var summary: String {
        let active = weeks.joined().filter { $0 > 0 }.count
        return active == 1 ? "Work on 1 day" : "Work on \(active) days"
    }
}

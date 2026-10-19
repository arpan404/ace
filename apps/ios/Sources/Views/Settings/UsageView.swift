import SwiftUI

private struct UsageReply: Decodable {
    struct Result: Decodable {
        struct Row: Decodable {
            struct Totals: Decodable {
                let inputTokens: Double
                let outputTokens: Double
                let cachedInputTokens: Double
                let providerReportedUsd: Double
                let estimatedUsd: Double
            }
            let dimensions: [String: String?]
            let totals: Totals
        }
        let rows: [Row]
        let truncated: Bool
        let timezone: String
        let omittedEvents: Int
    }
    let result: Result
}
struct UsageView: View {
    let model: ClientModel
    @State private var days = 7
    @State private var result: UsageReply.Result?
    @State private var problem: String?
    @State private var loading = false
    var body: some View {
        List {
            Picker("Period", selection: $days) { Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
                .pickerStyle(.segmented)
            if loading { ProgressView("Reading usage…") }
            ServiceProblem(message: problem)
            if let result {
                if result.rows.isEmpty { Text("No recorded usage in this period.") }
                ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                    Section(row.dimensions["provider"]?.flatMap { $0 }?.capitalized ?? "Usage") {
                        LabeledContent("Input tokens", value: row.totals.inputTokens.formatted())
                        LabeledContent("Output tokens", value: row.totals.outputTokens.formatted())
                        LabeledContent("Cached input", value: row.totals.cachedInputTokens.formatted())
                        LabeledContent("Reported cost", value: row.totals.providerReportedUsd.formatted(.currency(code: "USD")))
                        LabeledContent("Estimated cost", value: row.totals.estimatedUsd.formatted(.currency(code: "USD")))
                    }
                }
                if result.truncated || result.omittedEvents > 0 { Text("Some records are outside the retained window.") }
                Text("Dates use \(result.timezone). CLI token counts and estimated cost may differ from billing.")
                    .foregroundStyle(AceTheme.Colours.mutedForeground).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            }
        }
        .navigationTitle("Usage").navigationBarTitleDisplayMode(.inline)
        .task(id: days) { await read() }
        .refreshable { await read() }
    }
    private func read() async {
        loading = true; problem = nil
        defer { loading = false }
        let now = Date(timeIntervalSince1970: model.now() / 1000)
        let start = now.addingTimeInterval(-Double(days - 1) * 86400)
        let format = Date.ISO8601FormatStyle().year().month().day().dateSeparator(.dash)
        do {
            let reply = try await model.service(["type": "usage.summary", "query": ["from": start.formatted(format), "to": now.formatted(format), "groupBy": ["provider"], "limit": 100]], as: UsageReply.self)
            result = reply.result
        } catch { problem = error.localizedDescription }
    }
}

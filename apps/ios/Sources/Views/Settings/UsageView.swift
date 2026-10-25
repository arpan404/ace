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

/// `usage.limits` (`bridge/usage-limits.ts`): the shared Usage-page limits, worded by
/// `@ace/ui-core`, for Swift to draw beside the token use.
private struct UsageLimitsReply: Decodable {
    struct Pace: Codable, Sendable, Hashable {
        let label: String
        let token: String
    }
    struct Window: Codable, Sendable, Hashable {
        let id: String
        let label: String
        let leftPercent: Double
        let resets: String?
        let resetsAt: Double?
        let observedAt: Double
        let stale: Bool
        let old: Bool
        let pace: Pace?
    }
    struct Account: Codable, Sendable, Hashable {
        let key: String
        let label: String
        let plan: String?
        let signIn: String?
        let bankedResets: Double?
        let bankedExpiresAt: Double?
        let noSessionWindow: Bool
        let windows: [Window]
    }
    struct Provider: Codable, Sendable, Hashable {
        let key: String
        let provider: String
        let providerLabel: String
        let accounts: [Account]
    }
    let providers: [Provider]
    let quiet: [String]
}

struct UsageView: View {
    private enum Tab: Hashable { case limits, tokens }
    let model: ClientModel
    @State private var tab = Tab.limits
    @State private var days = 7
    @State private var result: UsageReply.Result?
    @State private var problem: String?
    @State private var loading = false
    @State private var limits: UsageLimitsReply?
    @State private var limitsProblem: String?
    @State private var limitsLoading = false
    private static let limitsRead: [String: Any] = ["type": "usage.limits"]

    /// Opens on the last limits this phone saw, read again behind them.
    init(model: ClientModel) {
        self.model = model
        _limits = State(initialValue: model.kept(Self.limitsRead, as: UsageLimitsReply.self))
    }
    var body: some View {
        List {
            Picker("View", selection: $tab) {
                Text("Limits").tag(Tab.limits)
                Text("Tokens").tag(Tab.tokens)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("usage.view")
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            Group {
                if tab == .tokens {
                    tokens
                } else {
                    limitsView
                }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Usage").navigationBarTitleDisplayMode(.inline)
        .task(id: [tab == .limits ? 0 : 1, model.readGeneration(Self.limitsRead)]) {
            if tab == .limits { await readLimits() } else { await readTokens() }
        }
        .task(id: days) { if tab == .tokens { await readTokens() } }
        .refreshable {
            if tab == .limits { await readLimits() } else { await readTokens() }
        }
    }
    @ViewBuilder private var tokens: some View {
        Picker("Period", selection: $days) { Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
            .pickerStyle(.segmented)
            .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
        if loading, result == nil { HStack { Spacer(); ProgressView().accessibilityLabel("Reading usage"); Spacer() }.listRowBackground(Color.clear) }
        ServiceProblem(message: problem)
        if let result {
            if result.rows.isEmpty { ContentUnavailableView("No usage in this period", systemImage: "chart.bar").listRowBackground(Color.clear) }
            ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                Section {
                    LabeledContent("Input tokens", value: row.totals.inputTokens.formatted())
                    LabeledContent("Output tokens", value: row.totals.outputTokens.formatted())
                    LabeledContent("Cached input", value: row.totals.cachedInputTokens.formatted())
                    LabeledContent("Reported cost", value: row.totals.providerReportedUsd.formatted(.currency(code: "USD")))
                    LabeledContent("Estimated cost", value: row.totals.estimatedUsd.formatted(.currency(code: "USD")))
                } header: { InsetHeader(row.dimensions["provider"]?.flatMap { $0 }?.capitalized ?? "Usage") }
            }
            if result.truncated || result.omittedEvents > 0 { Text("Some records are outside the retained window.") }
            Text("Dates use \(result.timezone). CLI token counts and estimated cost may differ from billing.")
                .foregroundStyle(AceTheme.Colours.mutedForeground).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
        }
    }
    @ViewBuilder private var limitsView: some View {
        if limitsLoading, limits == nil {
            HStack { Spacer(); ProgressView().accessibilityLabel("Reading limits"); Spacer() }.listRowBackground(Color.clear)
        }
        ServiceProblem(message: limitsProblem)
        if let limits {
            if limits.providers.isEmpty, limits.quiet.isEmpty {
                ContentUnavailableView("No accounts yet", systemImage: "chart.bar", description: Text("Add an account to see its limits."))
                    .listRowBackground(Color.clear)
            }
            ForEach(limits.providers, id: \.key) { provider in
                Section {
                    ForEach(provider.accounts, id: \.key) { account in
                        LimitAccountRow(account: account)
                    }
                } header: {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        ProviderMark(provider: provider.provider, size: 16)
                        InsetHeader(provider.providerLabel)
                    }
                }
            }
            if !limits.quiet.isEmpty {
                Text("No limits reported · \(limits.quiet.joined(separator: ", "))")
                    .foregroundStyle(AceTheme.Colours.mutedForeground).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            }
        }
    }
    private var tokensRead: [String: Any] {
        let now = Date(timeIntervalSince1970: model.now() / 1000)
        let start = now.addingTimeInterval(-Double(days - 1) * 86400)
        let format = Date.ISO8601FormatStyle().year().month().day().dateSeparator(.dash)
        return ["type": "usage.summary", "query": ["from": start.formatted(format), "to": now.formatted(format), "groupBy": ["provider"], "limit": 100]]
    }
    private func readTokens() async {
        let read = tokensRead
        if let kept = model.kept(read, as: UsageReply.self) { result = kept.result }
        loading = true; problem = nil
        defer { loading = false }
        do {
            let reply = try await model.read(read, as: UsageReply.self)
            result = reply.result
        } catch is CancellationError {} catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func readLimits() async {
        limitsLoading = true; limitsProblem = nil
        defer { limitsLoading = false }
        do {
            limits = try await model.read(Self.limitsRead, as: UsageLimitsReply.self)
        } catch is CancellationError {} catch { if !Task.isCancelled { limitsProblem = error.localizedDescription } }
    }
}

/// One account's windows with what is left, as the Mac Usage page's Limits view reads them.
private struct LimitAccountRow: View {
    let account: UsageLimitsReply.Account
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(account.label)
                .aceFont(AceTheme.Typography.rowTitle, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
            if let plan = account.plan {
                Text(String(plan.prefix(1)).uppercased() + String(plan.dropFirst()))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if let banked = account.bankedResets.map(Int.init), banked > 0 {
                Text(bankedLine(count: banked, expiresAt: account.bankedExpiresAt))
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            ForEach(account.windows, id: \.self) { window in
                LimitWindowRow(window: window)
            }
            if let signIn = account.signIn {
                Text(signIn)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if account.noSessionWindow {
                Text("No session (5h) limit reported for this account")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            }
        }
        .padding(.vertical, AceTheme.Spacing.xxs)
        .accessibilityElement(children: .combine)
    }
    private func bankedLine(count: Int, expiresAt: Double?) -> String {
        let resets = count == 1 ? "1 banked reset" : "\(count) banked resets"
        guard let expiresAt else { return resets }
        let date = Date(timeIntervalSince1970: expiresAt / 1000).formatted(date: .abbreviated, time: .omitted)
        return "\(resets) · next expires \(date)"
    }
}

private struct LimitWindowRow: View {
    let window: UsageLimitsReply.Window
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label)
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer(minLength: AceTheme.Spacing.sm)
                if window.stale {
                    Text("—").foregroundStyle(AceTheme.Colours.mutedForeground).monospacedDigit()
                } else {
                    Text("\(Int(window.leftPercent))% left")
                        .monospacedDigit()
                        .foregroundStyle(window.leftPercent == 0 ? StateStyle.text("failed") : AceTheme.Colours.foreground)
                }
            }
            if window.stale {
                if let resetsAt = window.resetsAt {
                    Text("Reset \(relative(resetsAt))")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
                Text("Read \(relative(window.observedAt))")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
            } else {
                if let pace = window.pace {
                    StateLabel(status: StatusDisplay(label: pace.label, token: pace.token))
                }
                Text(window.resets ?? "Reset not reported")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                if window.old {
                    Text("As of \(relative(window.observedAt))")
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
    private func relative(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000).formatted(.relative(presentation: .named))
    }
}

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

/// Settings › Usage: what is left of each account's limits, or the tokens spent per provider over
/// a period. Cardless: a provider heading over hairline rows, values muted at the right edge.
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
    var body: some View {
        List {
            Picker("View", selection: $tab) {
                Text("Limits").tag(Tab.limits)
                Text("Tokens").tag(Tab.tokens)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("usage.view")
            .usageBareRow()
            if tab == .tokens {
                tokens
            } else {
                limitsView
            }
        }
        .settingsList()
        .navigationTitle("Usage").navigationBarTitleDisplayMode(.inline)
        .task(id: tab) {
            if tab == .limits { await readLimits() } else { await readTokens() }
        }
        .task(id: days) { if tab == .tokens { await readTokens() } }
        .refreshable {
            if tab == .limits { await readLimits() } else { await readTokens() }
        }
    }
    @ViewBuilder private var tokens: some View {
        Section {
            SettingsRow(title: "Period") {
                Picker("Period", selection: $days) { Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90) }
                    .labelsHidden().pickerStyle(.menu).tint(AceTheme.Colours.mutedForeground)
            }
        } header: { SettingsHeader("Period", note: tokensNote) }
        .settingsRow()
        if let problem { ServiceProblem(message: problem).usageBareRow() }
        if let result {
            if result.rows.isEmpty, !loading {
                EmptyState(icon: .chartBar, title: "No recorded usage", line: "Nothing was recorded in this period.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                let key: String? = row.dimensions["provider"]?.flatMap { $0 }
                Section {
                    tokenRows(loading ? nil : row.totals)
                } header: {
                    if let key { UsageProviderHeading(provider: key, title: key.capitalized) } else { SettingsHeader("Usage") }
                }
                .settingsRow()
            }
        } else if loading {
            Section { tokenRows(nil) } header: { SettingsHeader("Usage") }
                .settingsRow()
        }
    }
    /// The period's caveats, once, under its heading.
    private var tokensNote: String? {
        guard let result else { return nil }
        let retained = result.truncated || result.omittedEvents > 0 ? "Some records are outside the retained window. " : ""
        return retained + "Dates use \(result.timezone). CLI token counts and estimated cost may differ from billing."
    }
    /// One provider's totals; nil while they are being read, which draws skeleton values.
    @ViewBuilder private func tokenRows(_ totals: UsageReply.Result.Row.Totals?) -> some View {
        UsageTokenRow(title: "Input tokens", value: totals?.inputTokens.formatted())
        UsageTokenRow(title: "Output tokens", value: totals?.outputTokens.formatted())
        UsageTokenRow(title: "Cached input", value: totals?.cachedInputTokens.formatted())
        UsageTokenRow(title: "Reported cost", value: totals?.providerReportedUsd.formatted(.currency(code: "USD")))
        UsageTokenRow(title: "Estimated cost", value: totals?.estimatedUsd.formatted(.currency(code: "USD")))
    }
    @ViewBuilder private var limitsView: some View {
        if let limitsProblem { ServiceProblem(message: limitsProblem).usageBareRow() }
        if let limits {
            if limits.providers.isEmpty, limits.quiet.isEmpty {
                EmptyState(icon: .chartBar, title: "No accounts yet", line: "Add an account to see its limits.")
                    .padding(.top, AceTheme.Spacing.xxxl).listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
            ForEach(limits.providers, id: \.key) { provider in
                Section {
                    ForEach(provider.accounts, id: \.key) { account in
                        LimitAccountRow(account: account)
                    }
                } header: { UsageProviderHeading(provider: provider.provider, title: provider.providerLabel) }
                .settingsRow()
            }
            if !limits.quiet.isEmpty {
                Text("No limits reported · \(limits.quiet.joined(separator: ", "))")
                    .foregroundStyle(AceTheme.Colours.mutedForeground).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .usageBareRow()
            }
        } else if limitsLoading {
            Section {
                ForEach(0..<2, id: \.self) { _ in UsageSkeletonRow() }
            }
            .settingsRow()
        }
    }
    private func readTokens() async {
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
    private func readLimits() async {
        limitsLoading = true; limitsProblem = nil
        defer { limitsLoading = false }
        do {
            limits = try await model.service(["type": "usage.limits"], as: UsageLimitsReply.self)
        } catch { limitsProblem = error.localizedDescription }
    }
}

private extension View {
    /// A line on the page between sections: no hairline, no fill, at the page margins.
    func usageBareRow() -> some View {
        self.listRowBackground(Color.clear).listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: AceTheme.Spacing.sm, leading: SettingsStyle.margin,
                                      bottom: AceTheme.Spacing.sm, trailing: SettingsStyle.margin))
    }
}

/// A section heading led by the provider's mark, in the same type and insets as `SettingsHeader`.
private struct UsageProviderHeading: View {
    let provider: String
    let title: String
    var body: some View {
        HStack(spacing: AceTheme.Spacing.sm) {
            ProviderMark(provider: provider, size: 16)
            Text(title).aceFont(SettingsStyle.heading, relativeTo: .headline)
                .foregroundStyle(AceTheme.Colours.foreground)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .listRowInsets(EdgeInsets(top: AceTheme.Spacing.none, leading: SettingsStyle.margin,
                                  bottom: AceTheme.Spacing.sm, trailing: SettingsStyle.margin))
    }
}

/// "Input tokens ─ 12,345"; a skeleton bar holds the value's place while it is read. The label
/// stays one accessible text found by its name, with the number as its value.
private struct UsageTokenRow: View {
    let title: String
    let value: String?
    var body: some View {
        SettingsRow(title: title) {
            if let value {
                SettingsValue(text: value).monospacedDigit()
            } else {
                UsageSkeletonBar(width: 64)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value ?? "Reading")
        .accessibilityAddTraits(.isStaticText)
    }
}

private struct UsageSkeletonBar: View {
    let width: CGFloat
    var body: some View {
        Capsule().fill(AceTheme.Colours.fill).frame(width: width, height: 10)
    }
}

/// An account row's place while limits are read.
private struct UsageSkeletonRow: View {
    var body: some View {
        HStack {
            UsageSkeletonBar(width: 120)
            Spacer(minLength: AceTheme.Spacing.sm)
            UsageSkeletonBar(width: 64)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Reading limits")
    }
}

/// One account's windows with what is left, as the Mac Usage page's Limits view reads them.
private struct LimitAccountRow: View {
    let account: UsageLimitsReply.Account
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
            Text(account.label)
                .aceFont(SettingsStyle.label, relativeTo: .body).foregroundStyle(AceTheme.Colours.foreground)
            if let detail {
                Text(detail)
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
    /// "Plus · 1 banked reset · next expires 3 Nov": the plan and banked resets on one muted line.
    private var detail: String? {
        let plan: String? = account.plan.map { String($0.prefix(1)).uppercased() + String($0.dropFirst()) }
        var banked: String?
        if let count = account.bankedResets.map(Int.init), count > 0 {
            banked = bankedLine(count: count, expiresAt: account.bankedExpiresAt)
        }
        let parts = [plan, banked].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
    private func bankedLine(count: Int, expiresAt: Double?) -> String {
        let resets = count == 1 ? "1 banked reset" : "\(count) banked resets"
        guard let expiresAt else { return resets }
        let date = Date(timeIntervalSince1970: expiresAt / 1000).formatted(date: .abbreviated, time: .omitted)
        return "\(resets) · next expires \(date)"
    }
}

/// "5h ─ 62% left", then when it resets, with the pace at the right. Muted throughout; an
/// exhausted window reads as failed and a pace that needs the person keeps its tone.
private struct LimitWindowRow: View {
    let window: UsageLimitsReply.Window
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // At accessibility sizes each value sits under its label.
        let stacked = typeSize.isAccessibilitySize
        let line = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: AceTheme.Spacing.xxs))
                           : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.sm))
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
            line {
                Text(window.label)
                if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                if window.stale {
                    Text("—").monospacedDigit()
                } else {
                    Text("\(Int(window.leftPercent))% left")
                        .monospacedDigit()
                        .foregroundStyle(window.leftPercent == 0 ? StateStyle.text("failed") : AceTheme.Colours.mutedForeground)
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
            line {
                Text(when).monospacedDigit()
                    .aceFont(AceTheme.Typography.caption, relativeTo: .caption).foregroundStyle(AceTheme.Colours.mutedForeground)
                if let pace = window.pace, !window.stale {
                    if !stacked { Spacer(minLength: AceTheme.Spacing.sm) }
                    StateLabel(status: StatusDisplay(label: pace.label, token: pace.token))
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
    /// "Resets in 2h · As of 5 min ago"; for a stale reading, when it reset and when it was read.
    private var when: String {
        if window.stale {
            let parts: [String?] = [window.resetsAt.map { "Reset \(relative($0))" }, "Read \(relative(window.observedAt))"]
            return parts.compactMap { $0 }.joined(separator: " · ")
        }
        let resets = window.resets ?? "Reset not reported"
        return window.old ? "\(resets) · As of \(relative(window.observedAt))" : resets
    }
    private func relative(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000).formatted(.relative(presentation: .named))
    }
}

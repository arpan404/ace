import SwiftUI

/// Settings › Usage: the web Usage page on the phone. Cost and Tokens over a range with growth
/// against the period before, a daily chart, totals, types and a breakdown; Limits with what is
/// left of every window. Every figure is worded by `@ace/ui-core` through the bridge.
struct UsageView: View {
    private enum Tab: String, Hashable { case cost, tokens, limits }
    let model: ClientModel
    @State private var tab = Tab.limits
    @State private var days = 30
    @State private var provider: String?
    @State private var report: UsageReportReply?
    @State private var reportProblem: String?
    @State private var reportLoading = false
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
        ScrollView {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xl) {
                controls
                Group {
                    if tab == .limits { limitsPage } else { spendPage }
                }
                .padding(.top, AceTheme.Spacing.sm)
            }
            .padding(.horizontal, AceTheme.Spacing.xl)
            .padding(.top, AceTheme.Spacing.sm)
            .padding(.bottom, AceTheme.Spacing.xxxl)
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
        }
        .background(AceTheme.Colours.background)
        .navigationTitle("Usage").navigationBarTitleDisplayMode(.inline)
        .task(id: readKey) { await read(fresh: false) }
        .refreshable { await read(fresh: true) }
    }

    private var readKey: [String] {
        tab == .limits
            ? ["limits", String(model.readGeneration(Self.limitsRead))]
            : ["report", String(days), provider ?? "", String(model.readGeneration(reportRead))]
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            Picker("View", selection: $tab) {
                Text("Cost").tag(Tab.cost)
                Text("Tokens").tag(Tab.tokens)
                Text("Limits").tag(Tab.limits)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("usage.view")
            if tab != .limits {
                Picker("Range", selection: $days) {
                    Text("Today").tag(1); Text("7 days").tag(7); Text("30 days").tag(30); Text("90 days").tag(90)
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("usage.range")
                if let providers = report?.providers, providers.count > 1 || provider != nil {
                    providerMenu(providers)
                }
            }
        }
    }

    private func providerMenu(_ providers: [UsageReportReply.Provider]) -> some View {
        Menu {
            Picker("Provider", selection: $provider) {
                Text("All providers").tag(String?.none)
                ForEach(providers, id: \.id) { entry in Text(entry.name).tag(Optional(entry.id)) }
            }
        } label: {
            Text(providers.first { $0.id == provider }?.name ?? "All providers")
                .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
        }
        .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(AceTheme.Colours.foreground)
        .accessibilityLabel("Provider")
        .accessibilityIdentifier("usage.provider")
    }

    @ViewBuilder private var spendPage: some View {
        ServiceProblem(message: reportProblem)
        if let report {
            let view = tab == .cost ? report.cost : report.tokens
            if view.providers.isEmpty, view.byDay.isEmpty {
                ContentUnavailableView("No usage in this range", systemImage: "chart.xyaxis.line")
                    .frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
            } else {
                UsageSpendView(view: view)
            }
        } else if reportLoading {
            loading("Reading usage")
        }
    }

    @ViewBuilder private var limitsPage: some View {
        ServiceProblem(message: limitsProblem)
        if let limits {
            if limits.providers.isEmpty, limits.quiet.isEmpty {
                ContentUnavailableView("No accounts yet", systemImage: "chart.bar",
                                       description: Text("Add an account to see its limits."))
                    .frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
            } else {
                UsageLimitsView(limits: limits, redeem: redeem)
            }
        } else if limitsLoading {
            loading("Reading limits")
        }
    }

    private func loading(_ label: String) -> some View {
        ProgressView().accessibilityLabel(label)
            .frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
    }

    private var reportRead: [String: Any] {
        var read: [String: Any] = ["type": "usage.report", "days": days]
        if let provider { read["provider"] = provider }
        return read
    }

    private func read(fresh: Bool) async {
        if tab == .limits { await readLimits(fresh: fresh) } else { await readReport(fresh: fresh) }
    }

    private func readReport(fresh: Bool) async {
        var read = reportRead
        if let kept = model.kept(read, as: UsageReportReply.self) { report = kept }
        if fresh { read["fresh"] = true }
        reportLoading = true; reportProblem = nil
        defer { reportLoading = false }
        do {
            report = try await model.read(read, as: UsageReportReply.self)
        } catch is CancellationError {} catch {
            if !Task.isCancelled { reportProblem = error.localizedDescription }
        }
    }

    private func readLimits(fresh: Bool) async {
        var read = Self.limitsRead
        if fresh { read["fresh"] = true }
        limitsLoading = true; limitsProblem = nil
        defer { limitsLoading = false }
        do {
            limits = try await model.read(read, as: UsageLimitsReply.self)
        } catch is CancellationError {} catch {
            if !Task.isCancelled { limitsProblem = error.localizedDescription }
        }
    }

    private func redeem(_ account: UsageLimitsReply.Account, _ key: String) async throws -> String {
        guard let instanceId = account.instanceId else { throw CancellationError() }
        let reply = try await model.service(
            ["type": "usage.useReset", "instanceId": instanceId, "idempotencyKey": key],
            as: UsageResetReply.self)
        await readLimits(fresh: true)
        return reply.words
    }
}

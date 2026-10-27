import SwiftUI

/// Settings › Usage: the web Usage page on the phone, over every paired machine or one. Cost
/// and Tokens over a range with growth against the period before, a daily chart, totals, types
/// and a breakdown; Limits with what is left of every window, each account under its machine.
/// Every figure is summed and worded by `@ace/ui-core` through the bridge
/// (`UsageMachineReads`); a machine that isn't counted is named, never dropped silently.
struct UsageView: View {
    private enum Tab: String, Hashable { case cost, tokens, limits }
    let inbox: MachineInbox
    @State private var tab = Tab.limits
    @State private var days = 30
    @State private var provider: String?
    /// One machine's id, or empty for every machine.
    @State private var scope: String
    @State private var report: UsageReportReply?
    @State private var reportProblem: String?
    @State private var reportLoading = false
    @State private var limits: UsageLimitsReply?
    @State private var limitsProblem: String?
    @State private var limitsLoading = false
    @State private var refreshing = false
    @State private var refreshed = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Opens on every machine when there are several, else on `machine`, drawing the last
    /// answers this run saw while it reads again behind them.
    init(inbox: MachineInbox, machine: String) {
        self.inbox = inbox
        let scope = inbox.sessions.count > 1 ? "" : machine
        _scope = State(initialValue: scope)
        _limits = State(initialValue: UsageMemo.limits[scope])
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
        // Pull to refresh does what the Refresh button does.
        .refreshable { await refresh() }
        .sensoryFeedback(.success, trigger: refreshed)
    }

    private var scoped: [MachineSession] {
        let chosen = inbox.sessions.filter { scope.isEmpty || $0.hostId == scope }
        return chosen.isEmpty ? inbox.sessions : chosen
    }
    private var reads: UsageMachineReads { UsageMachineReads(machines: scoped, name: inbox.name) }
    private var memoKey: String { [scope, String(days), provider ?? ""].joined(separator: "\u{0}") }

    /// Reads again when the view, range, provider or scope changes, when a machine connects or
    /// drops, and when a machine's kept usage goes out of date.
    private var readKey: [String] {
        let machines = scoped.map { session in
            let base: [String: Any] = tab == .limits ? ["type": "usage.accounts"] : ["type": "usage.part", "days": days]
            return "\(session.hostId):\(session.client.connection):\(session.client.readGeneration(base))"
        }
        let view = tab == .limits ? ["limits"] : ["report", String(days), provider ?? ""]
        return view + [scope] + machines
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
            }
            HStack(spacing: AceTheme.Spacing.sm) {
                if inbox.sessions.count > 1 { machineMenu }
                if tab != .limits, let providers = report?.providers, providers.count > 1 || provider != nil {
                    providerMenu(providers)
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                Button { Task { await refresh() } } label: {
                    Text(refreshing ? "Refreshing…" : "Refresh")
                        .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                        .padding(.horizontal, AceTheme.Spacing.xs)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }
                .disabled(refreshing)
                .accessibilityHint("Asks each machine for current limits and reads usage again")
                .accessibilityIdentifier("usage.refresh")
            }
            if inbox.sessions.count > 1 { coverageLine }
        }
    }

    /// Which machines the figures count, in one line. Its row is always there with several
    /// machines, so nothing below moves while they load; one counted machine leaves it blank,
    /// as the machine menu already names it.
    private var coverageLine: some View {
        let coverage = tab == .limits ? limits?.coverage : report?.coverage
        let words = coverage.map { $0.line ?? "" }
            ?? (scoped.count > 1 ? "Reading \(scoped.count) machines" : "Reading \(inbox.name(scoped.first?.hostId ?? scope))")
        return Text(words)
            .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
            .foregroundStyle(coverage?.complete == false ? AceTheme.Colours.foreground : AceTheme.Colours.subtleForeground)
            .lineLimit(2)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentTransition(.opacity)
            .animation(reduceMotion ? nil : .default, value: words)
            .accessibilityIdentifier("usage.coverage")
    }

    private var machineMenu: some View {
        Menu {
            Picker("Machine", selection: $scope) {
                Text("All machines").tag("")
                ForEach(inbox.sessions) { session in Text(inbox.name(session.hostId)).tag(session.hostId) }
            }
        } label: {
            Text(scope.isEmpty ? "All machines" : inbox.name(scope))
                .usageCapsule()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Machine")
        .accessibilityIdentifier("usage.machine")
        .onChange(of: scope) {
            report = UsageMemo.reports[memoKey]
            limits = UsageMemo.limits[scope]
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
                .usageCapsule()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Provider")
        .accessibilityIdentifier("usage.provider")
    }

    @ViewBuilder private var spendPage: some View {
        ServiceProblem(message: reportProblem)
        if let report {
            let view = tab == .cost ? report.cost : report.tokens
            if view.providers.isEmpty, view.byDay.isEmpty {
                if report.coverage.complete || reportLoading {
                    empty("No usage in this range", systemImage: "chart.xyaxis.line")
                } else {
                    empty("No usage could be read", systemImage: "chart.xyaxis.line", detail: report.coverage.line)
                }
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
                if limits.coverage.complete || limitsLoading {
                    empty("No accounts yet", systemImage: "chart.bar", detail: "Add an account to see its limits.")
                } else {
                    empty("No limits could be read", systemImage: "chart.bar", detail: limits.coverage.line)
                }
            } else {
                UsageLimitsView(limits: limits, redeem: redeem)
            }
        } else if limitsLoading {
            loading("Reading limits")
        }
    }

    private func empty(_ title: String, systemImage: String, detail: String? = nil) -> some View {
        ContentUnavailableView(title, systemImage: systemImage, description: detail.map { Text($0) })
            .frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
    }

    private func loading(_ label: String) -> some View {
        ProgressView().accessibilityLabel(label)
            .frame(maxWidth: .infinity).padding(.top, AceTheme.Spacing.xxxl)
    }

    private func read(fresh: Bool) async {
        if tab == .limits { await readLimits(fresh: fresh, refresh: false) } else { await readReport(fresh: fresh) }
    }

    /// The Refresh button and pull to refresh: every machine in scope asks its CLIs for current
    /// limits, and the open view reads again.
    private func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false; refreshed += 1 }
        await readLimits(fresh: true, refresh: true)
        if tab != .limits { await readReport(fresh: true) }
    }

    private func readReport(fresh: Bool) async {
        let key = memoKey
        if report == nil { report = UsageMemo.reports[key] }
        reportLoading = true; reportProblem = nil
        defer { reportLoading = false }
        let problem = await reads.report(days: days, provider: provider, fresh: fresh) { reply in
            guard !Task.isCancelled else { return }
            UsageMemo.reports[key] = reply
            report = reply
        }
        if !Task.isCancelled { reportProblem = problem }
    }

    private func readLimits(fresh: Bool, refresh: Bool) async {
        let key = scope
        limitsLoading = true; limitsProblem = nil
        defer { limitsLoading = false }
        let problem = await reads.limits(fresh: fresh, refresh: refresh) { reply in
            guard !Task.isCancelled else { return }
            UsageMemo.limits[key] = reply
            limits = reply
        }
        if !Task.isCancelled { limitsProblem = problem }
    }

    /// A banked reset goes through the machine whose reading the account shows.
    private func redeem(_ account: UsageLimitsReply.Account, _ key: String) async throws -> String {
        guard let instanceId = account.instanceId,
              let client = account.machineId.flatMap(inbox.client) ?? scoped.first?.client else { throw CancellationError() }
        let reply = try await client.service(
            ["type": "usage.useReset", "instanceId": instanceId, "idempotencyKey": key],
            as: UsageResetReply.self)
        await readLimits(fresh: true, refresh: false)
        return reply.words
    }
}

/// A filter menu's label: a slim capsule at the segmented controls' height, inside a 44pt tap
/// area, so it reads as light as the controls above it and is still easy to hit.
private struct UsageCapsule: ViewModifier {
    func body(content: Content) -> some View {
        content
            .aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
            .lineLimit(1)
            .foregroundStyle(AceTheme.Colours.foreground)
            .padding(.horizontal, AceTheme.Spacing.md)
            .frame(minHeight: 32)
            .background(.fill.tertiary, in: Capsule())
            .padding(.vertical, 6)
            .contentShape(Rectangle())
    }
}

private extension View {
    func usageCapsule() -> some View { modifier(UsageCapsule()) }
}

/// The last combined answers this run drew, by scope, so reopening Usage or switching back to a
/// machine draws at once while it reads again.
@MainActor enum UsageMemo {
    static var reports: [String: UsageReportReply] = [:]
    static var limits: [String: UsageLimitsReply] = [:]
}

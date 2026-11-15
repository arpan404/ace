import SwiftUI

/// Limits, account first, as the web Usage page lists them: each provider's accounts once, each
/// with its windows beneath it. Every figure says what is left; a window this pace runs out before
/// its reset is red with when it runs out, and a lasting one marks what its pace leaves at the reset.
struct UsageLimitsView: View {
    let limits: UsageLimitsReply
    /// Redeems one banked reset and answers with what happened.
    let redeem: (UsageLimitsReply.Account, String) async throws -> String
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.section) {
            ForEach(limits.providers, id: \.key) { provider in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    HStack(spacing: AceDesign.Space.related) {
                        ProviderMark(provider: provider.provider, size: AceDesign.Size.icon)
                        Text(provider.providerLabel).font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong))
                            .foregroundStyle(AceDesign.Ink.primary)
                    }
                    .padding(.bottom, AceDesign.Space.row)
                    .accessibilityAddTraits(.isHeader)
                    ForEach(provider.accounts, id: \.key) { account in
                        Hairline()
                        UsageLimitAccount(account: account, redeem: redeem)
                    }
                }
            }
            if !limits.quiet.isEmpty || !limits.unsure.isEmpty {
                VStack(alignment: .leading, spacing: AceDesign.Space.related) {
                    if !limits.quiet.isEmpty { Text("No limits reported · \(limits.quiet.joined(separator: ", "))") }
                    ForEach(limits.unsure, id: \.self) { Text($0) }
                }
                .font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.subtle)
            }
        }
    }
}

private struct UsageLimitAccount: View {
    let account: UsageLimitsReply.Account
    let redeem: (UsageLimitsReply.Account, String) async throws -> String
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.row) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(account.label).font(AceDesign.Typeface.body)
                    .fontWeight(.semibold).foregroundStyle(AceDesign.Ink.primary)
                // The plan beside the machine it was read on, as the web lists it: "Pro · Studio".
                let plan = account.plan.map { String($0.prefix(1)).uppercased() + String($0.dropFirst()) }
                let detail = [plan, account.machine].compactMap { $0 }
                if !detail.isEmpty {
                    Text(detail.joined(separator: " · "))
                        .font(AceDesign.Typeface.meta)
                        .foregroundStyle(AceDesign.Ink.subtle)
                }
            }
            ForEach(account.windows, id: \.id) { window in
                UsageLimitWindow(window: window)
            }
            if let signIn = account.signIn {
                Text(signIn).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
            }
            if account.noSessionWindow {
                Text("No session (5h) limit reported for this account")
                    .font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.subtle)
            }
            if let banked = account.bankedResets.map(Int.init), banked > 0 {
                UsageBankedResets(account: account, count: banked, redeem: redeem)
            }
        }
        .padding(.vertical, AceDesign.Space.margin)
    }
}

private struct UsageLimitWindow: View {
    let window: UsageLimitsReply.Window
    private var out: Bool { !window.stale && window.leftPercent == 0 }
    /// Out, or running out before the reset at this pace (`limitWhen`): the figure, bar and words go red.
    private var runsOut: Bool { out || window.when?.runsOut == true }
    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label).font(AceDesign.Typeface.body)
                    .foregroundStyle(AceDesign.Ink.muted)
                Spacer(minLength: AceDesign.Space.related)
                if window.stale {
                    Text("—").font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong)).foregroundStyle(AceDesign.Ink.subtle)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: AceDesign.Space.tight) {
                        Text("\(Int(window.leftPercent))%").font(AceDesign.Typeface.title.weight(AceDesign.Typeface.strong)).monospacedDigit()
                            .foregroundStyle(runsOut ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                        Text("left").font(AceDesign.Typeface.meta)
                            .foregroundStyle(AceDesign.Ink.subtle)
                    }
                }
            }
            meter
            HStack(alignment: .firstTextBaseline) {
                if let pace = window.pace, !window.stale {
                    StateLabel(status: StatusDisplay(label: pace.label, token: pace.token))
                }
                Spacer(minLength: AceDesign.Space.related)
                VStack(alignment: .trailing, spacing: AceTheme.Spacing.none) {
                    Text(resetWords).monospacedDigit()
                        .foregroundStyle(runsOut ? AceTheme.StatusText.failed : AceDesign.Ink.subtle)
                        .accessibilityLabel(window.when?.spoken ?? resetWords)
                    if window.stale || window.old {
                        Text("\(window.stale ? "Read" : "As of") \(relative(window.observedAt))")
                            .foregroundStyle(AceDesign.Ink.subtle)
                    }
                }
            }
            .font(AceDesign.Typeface.meta)
        }
        .accessibilityElement(children: .combine)
    }
    /// The meter's drawing: a thin bar, and the dash a stale reading draws instead.
    private static let meterHeight: CGFloat = 3
    /// The pace part's amber, and the gap that parts it from what will be left.
    private static let paceWash: Double = 0.55
    private static let notch: CGFloat = 2
    private static func share(_ percent: Double) -> CGFloat { CGFloat(min(1, max(0, percent / 100))) }
    private static let staleLine: CGFloat = 2
    private static let staleDash: [CGFloat] = [3, 3]
    /// What is left as a hairline meter; a stale reading is a dashed line with no figure.
    @ViewBuilder private var meter: some View {
        if window.stale {
            Line().stroke(AceTheme.Colours.separator, style: StrokeStyle(lineWidth: Self.staleLine, dash: Self.staleDash)).frame(height: Self.staleLine)
        } else {
            GeometryReader { box in
                let left = box.size.width * Self.share(window.leftPercent)
                // Where this pace leaves it at the reset; what lies between is what the pace still uses.
                let marker = runsOut ? nil : window.leftAtReset.map { box.size.width * Self.share($0) }
                ZStack(alignment: .leading) {
                    AceDesign.Shape.control.fill(out ? AceTheme.StatusText.failed.opacity(AceDesign.Ink.recede) : AceTheme.Colours.separator)
                    if let marker, marker < left {
                        AceDesign.Shape.control.fill(AceDesign.Status.needsYou.opacity(Self.paceWash))
                            .frame(width: left)
                        AceDesign.Shape.control.fill(AceDesign.Ink.primary)
                            .frame(width: max(0, marker - Self.notch / 2))
                    } else {
                        AceDesign.Shape.control.fill(runsOut ? AceTheme.StatusText.failed : AceDesign.Ink.primary)
                            .frame(width: left)
                    }
                }
            }
            .frame(height: Self.meterHeight)
        }
    }
    private var resetWords: String {
        if let when = window.when, when.runsOut, !out { return when.text }
        if window.stale { return window.resetsAt.map { "Reset \(relative($0))" } ?? "Reset since this reading" }
        guard let resets = window.resets else { return "Reset not reported" }
        return out ? resets.replacingOccurrences(of: "Resets in", with: "Back in") : resets
    }
    private func relative(_ epochMs: Double) -> String {
        Date(timeIntervalSince1970: epochMs / 1000).formatted(.relative(presentation: .named))
    }
    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            Path { $0.move(to: CGPoint(x: 0, y: rect.midY)); $0.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)) }
        }
    }
}

/// "3 banked resets": Codex redeems one here after a confirmation; Claude's live in Claude.
private struct UsageBankedResets: View {
    let account: UsageLimitsReply.Account
    let count: Int
    let redeem: (UsageLimitsReply.Account, String) async throws -> String
    @State private var confirming = false
    @State private var pending = false
    @State private var attempt: String?
    @State private var notice: String?

    var body: some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(words).font(AceDesign.Typeface.meta)
                .foregroundStyle(AceDesign.Ink.muted)
            if account.provider == "claude", let url = URL(string: "https://claude.ai/settings/usage") {
                Link("Use reset in Claude", destination: url)
                    .font(AceDesign.Typeface.body)
            } else if account.provider == "codex", account.instanceId != nil {
                Button(pending ? "Applying…" : attempt == nil ? "Use reset" : "Retry reset") { confirming = true }
                    .font(AceDesign.Typeface.body)
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(AceDesign.Ink.accent)
                    .disabled(pending)
                    .confirmationDialog("Use one banked reset?", isPresented: $confirming, titleVisibility: .visible) {
                        Button("Use reset") { Task { await use() } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This spends one saved reset for \(account.label)\(account.machine.map { " on \($0)" } ?? ""). Codex decides which limits it resets.")
                    }
            }
            if let notice {
                Text(notice).font(AceDesign.Typeface.meta)
                    .foregroundStyle(AceDesign.Ink.muted)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
    }
    private var words: String {
        let resets = count == 1 ? "1 banked reset" : "\(count) banked resets"
        guard let expires = account.bankedExpiresAt else { return resets }
        let date = Date(timeIntervalSince1970: expires / 1000).formatted(.dateTime.month(.abbreviated).day())
        return "\(resets) · next expires \(date)"
    }
    private func use() async {
        let key = attempt ?? UUID().uuidString.lowercased()
        attempt = key; pending = true; notice = nil
        defer { pending = false }
        do {
            notice = try await redeem(account, key)
            attempt = nil
        } catch {
            notice = "Couldn't confirm the reset. Retry to check the same attempt."
        }
    }
}

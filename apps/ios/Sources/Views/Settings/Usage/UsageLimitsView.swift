import SwiftUI

/// Limits, account first, as the web Usage page lists them: each provider's accounts once, each
/// with its windows beneath it. Every figure says what is left; only a spent window or running
/// ahead of pace takes a status colour.
struct UsageLimitsView: View {
    let limits: UsageLimitsReply
    /// Redeems one banked reset and answers with what happened.
    let redeem: (UsageLimitsReply.Account, String) async throws -> String
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xxxl) {
            ForEach(limits.providers, id: \.key) { provider in
                VStack(alignment: .leading, spacing: AceTheme.Spacing.none) {
                    HStack(spacing: AceTheme.Spacing.sm) {
                        ProviderMark(provider: provider.provider, size: 16)
                        Text(provider.providerLabel).aceFont(AceTheme.Typography.title, relativeTo: .headline)
                            .foregroundStyle(AceTheme.Colours.foreground)
                    }
                    .padding(.bottom, AceTheme.Spacing.md)
                    .accessibilityAddTraits(.isHeader)
                    ForEach(provider.accounts, id: \.key) { account in
                        Hairline()
                        UsageLimitAccount(account: account, redeem: redeem)
                    }
                }
            }
            if !limits.quiet.isEmpty || !limits.unsure.isEmpty {
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    if !limits.quiet.isEmpty { Text("No limits reported · \(limits.quiet.joined(separator: ", "))") }
                    ForEach(limits.unsure, id: \.self) { Text($0) }
                }
                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
        }
    }
}

private struct UsageLimitAccount: View {
    let account: UsageLimitsReply.Account
    let redeem: (UsageLimitsReply.Account, String) async throws -> String
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.md) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(account.label).aceFont(InsetStyle.label, relativeTo: .body)
                    .fontWeight(.semibold).foregroundStyle(AceTheme.Colours.foreground)
                // The plan beside the machine it was read on, as the web lists it: "Pro · Studio".
                let plan = account.plan.map { String($0.prefix(1)).uppercased() + String($0.dropFirst()) }
                let detail = [plan, account.machine].compactMap { $0 }
                if !detail.isEmpty {
                    Text(detail.joined(separator: " · "))
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        .foregroundStyle(AceTheme.Colours.subtleForeground)
                }
            }
            ForEach(account.windows, id: \.id) { window in
                UsageLimitWindow(window: window)
            }
            if let signIn = account.signIn {
                Text(signIn).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
            }
            if account.noSessionWindow {
                Text("No session (5h) limit reported for this account")
                    .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.subtleForeground)
            }
            if let banked = account.bankedResets.map(Int.init), banked > 0 {
                UsageBankedResets(account: account, count: banked, redeem: redeem)
            }
        }
        .padding(.vertical, AceTheme.Spacing.lg)
    }
}

private struct UsageLimitWindow: View {
    let window: UsageLimitsReply.Window
    private var out: Bool { !window.stale && window.leftPercent == 0 }
    var body: some View {
        VStack(alignment: .leading, spacing: AceTheme.Spacing.xs + AceTheme.Spacing.xxs) {
            HStack(alignment: .firstTextBaseline) {
                Text(window.label).aceFont(InsetStyle.value, relativeTo: .body)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
                Spacer(minLength: AceTheme.Spacing.sm)
                if window.stale {
                    Text("—").font(.system(size: 19, weight: .semibold)).foregroundStyle(AceTheme.Colours.subtleForeground)
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: AceTheme.Spacing.xs) {
                        Text("\(Int(window.leftPercent))%").font(.system(size: 19, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(out ? AceTheme.StatusText.failed : AceTheme.Colours.foreground)
                        Text("left").aceFont(AceTheme.Typography.caption, relativeTo: .caption)
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                    }
                }
            }
            meter
            HStack(alignment: .firstTextBaseline) {
                if let pace = window.pace, !window.stale {
                    StateLabel(status: StatusDisplay(label: pace.label, token: pace.token))
                }
                Spacer(minLength: AceTheme.Spacing.sm)
                VStack(alignment: .trailing, spacing: AceTheme.Spacing.none) {
                    Text(resetWords).monospacedDigit()
                        .foregroundStyle(out ? AceTheme.StatusText.failed : AceTheme.Colours.subtleForeground)
                    if window.stale || window.old {
                        Text("\(window.stale ? "Read" : "As of") \(relative(window.observedAt))")
                            .foregroundStyle(AceTheme.Colours.subtleForeground)
                    }
                }
            }
            .aceFont(AceTheme.Typography.caption, relativeTo: .caption)
        }
        .accessibilityElement(children: .combine)
    }
    /// What is left as a hairline meter; a stale reading is a dashed line with no figure.
    @ViewBuilder private var meter: some View {
        if window.stale {
            Line().stroke(AceTheme.Colours.separator, style: StrokeStyle(lineWidth: 2, dash: [3, 3])).frame(height: 2)
        } else {
            GeometryReader { box in
                ZStack(alignment: .leading) {
                    Capsule().fill(out ? AceTheme.StatusText.failed.opacity(0.5) : AceTheme.Colours.separator)
                    Capsule().fill(AceTheme.Colours.foreground)
                        .frame(width: box.size.width * min(1, max(0, window.leftPercent / 100)))
                }
            }
            .frame(height: 3)
        }
    }
    private var resetWords: String {
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
        VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
            Text(words).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                .foregroundStyle(AceTheme.Colours.mutedForeground)
            if account.provider == "claude", let url = URL(string: "https://claude.ai/settings/usage") {
                Link("Use reset in Claude", destination: url)
                    .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
            } else if account.provider == "codex", account.instanceId != nil {
                Button(pending ? "Applying…" : attempt == nil ? "Use reset" : "Retry reset") { confirming = true }
                    .aceFont(AceTheme.Typography.label, relativeTo: .footnote)
                    .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(AceTheme.Colours.foreground)
                    .disabled(pending)
                    .confirmationDialog("Use one banked reset?", isPresented: $confirming, titleVisibility: .visible) {
                        Button("Use reset") { Task { await use() } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This spends one saved reset for \(account.label)\(account.machine.map { " on \($0)" } ?? ""). Codex decides which limits it resets.")
                    }
            }
            if let notice {
                Text(notice).aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground)
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

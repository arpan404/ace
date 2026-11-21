import AppKit
import SwiftUI

enum Tab: String, CaseIterable, Decodable {
    case agents, apps, usage

    var title: String {
        switch self {
        case .agents: "Agents"
        case .apps: "Computer use"
        case .usage: "Usage"
        }
    }
}

struct Snapshot: Decodable {
    struct Row: Decodable, Identifiable {
        let id: String
        let title: String
        let provider: String?
        let status: String
        let needsYou: Bool
        let elapsed: String?
    }

    struct Apps: Decodable {
        struct Row: Decodable, Identifiable {
            let id: String
            let title: String
            let bundleId: String
            let status: String
            let mode: String
            let canTakeOver: Bool
            let canStop: Bool
        }

        let enabled: Bool
        let rows: [Row]
    }

    struct Account: Decodable, Identifiable {
        struct Window: Decodable, Identifiable {
            let id: String
            let label: String
            let left: Double?
            let resetsAt: Double?
        }

        let id: String
        let accountId: String
        let title: String
        let provider: String
        let signIn: String?
        let bankedResets: Int?
        let windows: [Window]
    }

    struct Usage: Decodable {
        let observedAt: Double
        let rows: [Account]
    }

    struct Pause: Decodable {
        let paused: Bool
        let canChange: Bool
        let action: String
    }

    struct Appearance: Decodable {
        struct Palette: Decodable {
            let surface: String
            let text: String
            let muted: String
            let accent: String
            let needs: String
            let opacity: Double
        }

        let radius: Double?
        let border: Double?
        let compact: Bool?
        let font: String?
        let dark: Bool
        let palette: Palette
    }

    let tab: Tab
    let working: Int?
    let needsYou: Int?
    let appsInUse: Int?
    let threads: [Row]?
    let apps: Apps?
    let usage: Usage?
    let pause: Pause?
    let appearance: Appearance?
    let problem: String?
}

final class TrayModel: ObservableObject {
    @Published var tab: Tab = .agents
    @Published private(set) var snapshot: Snapshot?
    private let marks = ["antigravity", "claude", "codex", "cursor", "opencode", "pi"]
    private lazy var providerImages: [String: NSImage] = {
        let folder = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            .appendingPathComponent("tray-marks", isDirectory: true)
        return Dictionary(uniqueKeysWithValues: marks.compactMap { name in
            NSImage(contentsOf: folder.appendingPathComponent("\(name).svg")).map { (name, $0) }
        })
    }()

    func providerIcon(_ provider: String) -> NSImage? { providerImages[provider] }

    func receive(_ snapshot: Snapshot) -> Bool {
        guard tab == snapshot.tab else { return false }
        self.snapshot = snapshot
        return true
    }

    func send(_ action: String, _ arguments: [String: Any] = [:]) {
        var value = arguments
        value["action"] = action
        guard var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

struct TrayView: View {
    @ObservedObject var model: TrayModel
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Namespace private var tabThumb
    @State private var reset: Snapshot.Account?

    private var snapshot: Snapshot? { model.snapshot }
    private var palette: Snapshot.Appearance.Palette? { snapshot?.appearance?.palette }
    private var foreground: Color { palette?.text.trayColor ?? .primary }
    private var muted: Color { palette?.muted.trayColor ?? .secondary }
    private var needs: Color { palette?.needs.trayColor ?? .orange }
    private var accent: Color { palette?.accent.trayColor ?? .accentColor }
    private var ink: TrayInk { TrayInk(foreground: foreground, muted: muted, font: snapshot?.appearance?.font) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            tabs.padding(.bottom, 4)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    switch model.tab {
                    case .agents: agents
                    case .apps: apps
                    case .usage: usage
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
                .background(TrayOverlayScroller())
            }
            if let problem = snapshot?.problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(ink.ui(12)).foregroundStyle(needs)
                    .padding(.horizontal, 8).padding(.vertical, 6)
            }
            footer
        }
        .padding(8)
        .font(ink.ui(13))
        .foregroundStyle(foreground)
        .tint(accent)
        .background(palette.map { $0.surface.trayColor.opacity(reduceTransparency ? 1 : $0.opacity) } ?? .clear)
        .preferredColorScheme(snapshot?.appearance.map { $0.dark ? .dark : .light })
    }

    // MARK: Header and tabs

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(headline).font(ink.ui(14)).fontWeight(.semibold).monospacedDigit()
            if let count = snapshot?.needsYou, count > 0 {
                Text("\(count) \(count == 1 ? "needs" : "need") you")
                    .font(ink.ui(13)).fontWeight(.medium).monospacedDigit().foregroundStyle(needs)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 10)
        .accessibilityElement(children: .combine)
    }

    private var headline: String {
        guard let count = snapshot?.working else { return "Syncing…" }
        return count == 0 ? "Nothing working" : "\(count) working"
    }

    private var tabs: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { tab in
                let selected = model.tab == tab
                let count = tab == .apps ? snapshot?.appsInUse ?? 0 : 0
                Button {
                    guard !selected else { return }
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.86)) {
                        model.tab = tab
                    }
                    model.send("tab", ["tab": tab.rawValue])
                } label: {
                    HStack(spacing: 4) {
                        Text(tab.title).fontWeight(.medium)
                        if count > 0 {
                            Text("\(count)").monospacedDigit().foregroundStyle(muted)
                        }
                    }
                    .font(ink.ui(12))
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundStyle(selected ? foreground : muted)
                    .frame(maxWidth: .infinity)
                    .frame(height: 24)
                    .background {
                        if selected {
                            Capsule().fill(foreground.opacity(0.1))
                                .matchedGeometryEffect(id: "thumb", in: tabThumb)
                        }
                    }
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(count > 0 ? "\(tab.title), \(count) in use" : tab.title)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
        }
        .padding(2)
        .background(foreground.opacity(0.05), in: Capsule())
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Show")
    }

    // MARK: Agents

    @ViewBuilder private var agents: some View {
        if let rows = snapshot?.threads {
            if rows.isEmpty { note("Nothing needs you.") }
            let waiting = rows.filter(\.needsYou)
            threadRows("Needs you", waiting, first: true)
            threadRows("Working", rows.filter { !$0.needsYou }, first: waiting.isEmpty)
        } else { note("Syncing…") }
    }

    @ViewBuilder private func threadRows(_ title: String, _ rows: [Snapshot.Row], first: Bool) -> some View {
        if !rows.isEmpty {
            sectionLabel(title).padding(.top, first ? 2 : 10)
            ForEach(rows) { row in
                Button { model.send("thread", ["id": row.id]) } label: {
                    HStack(spacing: 10) {
                        providerMark(row.provider)
                        details(row.title, row.status)
                        Spacer(minLength: 6)
                        if let elapsed = row.elapsed {
                            Text(elapsed).font(ink.ui(12)).monospacedDigit().foregroundStyle(muted)
                        }
                        Image(systemName: statusSymbol(row))
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(row.needsYou ? needs : muted.opacity(0.8))
                            .frame(width: 16)
                            .accessibilityHidden(true)
                    }
                    .padding(.horizontal, 8)
                    .frame(maxWidth: .infinity, minHeight: snapshot?.appearance?.compact == true ? 38 : 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(TrayRowStyle(ink: foreground))
            }
        }
    }

    @ViewBuilder private func providerMark(_ provider: String?) -> some View {
        if let provider, let icon = model.providerIcon(provider) {
            Image(nsImage: icon)
                .renderingMode(provider == "claude" ? .original : .template)
                .resizable().scaledToFit().frame(width: 16, height: 16)
                .foregroundStyle(foreground.opacity(0.85)).accessibilityLabel(provider)
        } else {
            Image(systemName: "circle.grid.2x2").font(.system(size: 13))
                .frame(width: 16, height: 16)
                .foregroundStyle(muted).accessibilityHidden(true)
        }
    }

    private func statusSymbol(_ row: Snapshot.Row) -> String {
        if !row.needsYou { return "circle.dashed" }
        if row.status.localizedCaseInsensitiveContains("question") { return "questionmark.circle.fill" }
        return "hand.raised.fill"
    }

    // MARK: Computer use

    @ViewBuilder private var apps: some View {
        if let apps = snapshot?.apps {
            HStack(spacing: 10) {
                Text("Let agents use apps")
                Spacer(minLength: 8)
                Toggle("Let agents use apps", isOn: Binding(get: { apps.enabled }, set: {
                    model.send("enable", ["enabled": $0])
                }))
                .labelsHidden().toggleStyle(.switch).controlSize(.mini)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 34)
            if apps.enabled && !apps.rows.isEmpty { sectionLabel("In use").padding(.top, 8) }
            if apps.enabled && apps.rows.isEmpty { note("No agent is using an app.") }
            ForEach(apps.rows) { row in
                HStack(spacing: 10) {
                    appIcon(row.bundleId)
                    details(row.title, "\(row.status) · \(row.mode)")
                    Spacer(minLength: 6)
                    if row.canTakeOver {
                        Button("Take over") { model.send("takeover", ["id": row.id]) }
                            .buttonStyle(TrayPillStyle(ink: foreground, tone: foreground))
                    }
                    if row.canStop {
                        Button("Stop") { model.send("stop", ["id": row.id]) }
                            .buttonStyle(TrayPillStyle(ink: foreground, tone: muted))
                    }
                }
                .font(ink.ui(13))
                .padding(.horizontal, 8)
                .frame(minHeight: 44)
            }
        } else {
            note(snapshot?.working == nil || snapshot?.tab != .apps
                 ? "Syncing…" : "Computer use isn’t available on this computer.")
        }
        separator.padding(.vertical, 6)
        command("Computer use settings…") { model.send("settings") }
    }

    @ViewBuilder private func appIcon(_ bundleId: String) -> some View {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: url.path))
                .resizable().frame(width: 20, height: 20).accessibilityHidden(true)
        } else {
            Image(systemName: "macwindow").font(.system(size: 14))
                .frame(width: 20, height: 20).foregroundStyle(muted).accessibilityHidden(true)
        }
    }

    // MARK: Usage

    @ViewBuilder private var usage: some View {
        if let usage = snapshot?.usage {
            if usage.rows.isEmpty { note("No usage limits reported.") }
            ForEach(usage.rows) { account in
                accountCard(account).padding(.bottom, 6)
            }
        } else {
            note(snapshot?.working == nil || snapshot?.tab != .usage
                 ? "Syncing…" : "Couldn’t load usage.")
        }
        let read = snapshot?.usage?.observedAt ?? 0
        command(
            "Open Usage",
            trailing: read > 0
                ? "Read \(Date(timeIntervalSince1970: read / 1000).formatted(.relative(presentation: .named)))"
                : nil
        ) { model.send("usage") }
    }

    private func accountCard(_ account: Snapshot.Account) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(account.title).fontWeight(.medium).lineLimit(1)
                Text(account.provider).font(ink.ui(12)).foregroundStyle(muted).lineLimit(1)
                Spacer(minLength: 6)
                if let count = account.bankedResets, count > 0, reset?.id != account.id {
                    Button("\(count) banked \(count == 1 ? "reset" : "resets")") { reset = account }
                        .buttonStyle(TrayPillStyle(ink: foreground, tone: accent))
                }
            }
            if let signIn = account.signIn {
                Text(signIn).font(ink.ui(12)).foregroundStyle(needs)
            }
            ForEach(account.windows) { window in usageWindow(window) }
            if reset?.id == account.id {
                HStack(spacing: 6) {
                    Text("Use one banked reset?").font(ink.ui(12)).foregroundStyle(muted)
                    Spacer(minLength: 6)
                    Button("Cancel") { reset = nil }
                        .buttonStyle(TrayPillStyle(ink: foreground, tone: muted))
                    Button("Use reset") {
                        model.send("reset", ["id": account.accountId])
                        reset = nil
                    }
                    .buttonStyle(TrayPillStyle(ink: foreground, tone: accent))
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(foreground.opacity(0.04), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityElement(children: .contain)
    }

    private func usageWindow(_ window: Snapshot.Account.Window) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(window.label).lineLimit(1)
                if let reset = window.resetsAt, window.left != nil {
                    Text("· resets \(Date(timeIntervalSince1970: reset / 1000).formatted(.relative(presentation: .named)))")
                        .foregroundStyle(muted).lineLimit(1)
                }
                Spacer(minLength: 6)
                if let left = window.left {
                    Text("\(Int(left.rounded()))% left").monospacedDigit()
                        .foregroundStyle(left < 20 ? needs : foreground)
                } else {
                    Text("Awaiting refresh").foregroundStyle(muted)
                }
            }
            .font(ink.ui(12))
            TrayMeter(
                fraction: window.left.map { min(100, max(0, $0)) / 100 },
                fill: (window.left ?? 100) < 20 ? needs : accent,
                track: foreground.opacity(0.08)
            )
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Footer and shared pieces

    private var footer: some View {
        VStack(spacing: 0) {
            separator.padding(.vertical, 6)
            command("Open ace", trailing: "⌘O") { model.send("open") }
                .keyboardShortcut("o")
            if let pause = snapshot?.pause {
                command(pause.action) { model.send("pause", ["paused": !pause.paused]) }
                    .disabled(!pause.canChange)
            }
            separator.padding(.vertical, 6)
            command("Quit ace", trailing: "⌘Q") { model.send("quit") }
                .keyboardShortcut("q")
            command("Quit ace completely") { model.send("quitCompletely") }
        }
    }

    private var separator: some View {
        Rectangle().fill(foreground.opacity(0.1))
            .frame(height: (snapshot?.appearance?.border ?? 1) / displayScale)
            .padding(.horizontal, 8)
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title).font(ink.ui(12)).fontWeight(.medium).foregroundStyle(muted)
            .padding(.horizontal, 8).padding(.bottom, 2)
            .accessibilityAddTraits(.isHeader)
    }

    private func note(_ text: String) -> some View {
        Text(text).foregroundStyle(muted).padding(.horizontal, 8).frame(minHeight: 30)
    }

    private func details(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).lineLimit(1)
            Text(subtitle).font(ink.ui(12)).foregroundStyle(muted).lineLimit(1)
        }
    }

    private func command(
        _ title: String,
        trailing: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                if let trailing {
                    Text(trailing).font(ink.ui(12)).foregroundStyle(muted.opacity(0.85))
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 8)
            .frame(maxWidth: .infinity, minHeight: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(TrayRowStyle(ink: foreground))
    }
}

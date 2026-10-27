import SwiftUI
import UIKit

/// One machine's Diagnostics: read-only checks, ace's health, a support bundle to share, the
/// worktree preparation deadline and a reset of its settings. Repairs and `ace triage` stay on
/// the computer (ADR 0092). Words come from `bridge/host-diagnostics.ts`.
struct HostDiagnosticsView: View {
    let model: ClientModel
    @State private var page: HostDiagnosticsPage?
    @State private var problem: String?
    @State private var checks: HostChecksReply?
    @State private var checking = false
    @State private var checksProblem: String?
    @State private var includeThreads = false
    @State private var exporting = false
    @State private var bundle: URL?
    @State private var bundleProblem: String?
    @State private var timeoutProblem: String?
    @State private var resetting = false
    @State private var resetProblem: String?
    @State private var confirmingReset = false
    @State private var copied = 0
    @State private var resets = 0
    private static let read: [String: Any] = ["type": "host.diagnostics"]

    init(model: ClientModel) {
        self.model = model
        _page = State(initialValue: model.kept(Self.read, as: HostDiagnosticsPage.self))
    }

    var body: some View {
        List {
            Group {
                checksSection
                supportSection
                healthSection
                if let timeout = page?.worktreeTimeout {
                    Section {
                        NumberRow(title: "Preparation timeout", unit: "min", value: timeout.minutes, pinnedBy: timeout.pinnedBy) { minutes in
                            page = try await model.service(["type": "host.worktreeTimeout", "minutes": minutes], as: HostDiagnosticsPage.self)
                        } failed: { timeoutProblem = $0 }
                        .disabled(!model.canOperate)
                        ServiceProblem(message: timeoutProblem)
                    } header: { InsetHeader("Worktrees") } footer: { Text("How long setting up a new worktree may take before it fails.") }
                }
                if model.canOperate { resetSection }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .animation(.smooth, value: checks)
        .animation(.smooth, value: page)
        .animation(.smooth, value: bundle)
        .sensoryFeedback(.success, trigger: copied)
        .sensoryFeedback(.success, trigger: resets)
        .navigationTitle("Diagnostics").navigationBarTitleDisplayMode(.inline)
        .readWhenConnected(model, id: model.readGeneration(Self.read)) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private var checksSection: some View {
        Section {
            Button(checking ? "Checking…" : "Run checks") { runChecks() }
                .disabled(checking || model.connection != "ready").accessibilityIdentifier("diagnostics.run")
            if let checks {
                Text(checks.summary).accessibilityIdentifier("diagnostics.summary")
                ForEach(checks.rows) { row in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        HStack {
                            Text(row.label)
                            Spacer(minLength: AceTheme.Spacing.sm)
                            StateLabel(status: StatusDisplay(label: row.word, token: row.status == "ok" ? "done" : "failed"))
                        }
                        Group {
                            Text(row.message)
                            if let fix = row.fix { Text(fix) }
                        }
                        .aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTheme.Colours.mutedForeground)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            ServiceProblem(message: checksProblem)
        } header: { InsetHeader("Checks") }
    }

    @ViewBuilder private var supportSection: some View {
        Section {
            Toggle("Include conversations", isOn: $includeThreads).disabled(exporting)
                .onChange(of: includeThreads) { bundle = nil }
            if let bundle {
                ShareLink(item: bundle) { Text("Share support bundle") }
                    .transition(.opacity).accessibilityIdentifier("diagnostics.share")
            } else {
                Button(exporting ? "Exporting…" : "Export support bundle") { export() }
                    .disabled(exporting || model.connection != "ready").accessibilityIdentifier("diagnostics.export")
            }
            ServiceProblem(message: bundleProblem)
        } header: { InsetHeader("Support bundle") } footer: {
            Text("Recent logs, checks and settings, with known secrets and personal paths removed. Nothing is uploaded. Review the file before sharing it, especially with conversations.")
        }
    }

    @ViewBuilder private var healthSection: some View {
        Section {
            if let health = page?.health {
                ForEach(health.rows, id: \.self) { row in LabeledContent(row.label) { Text(row.value).monospacedDigit() } }
                ForEach(health.queues, id: \.self) { queue in LabeledContent(queue.name) { Text(queue.depth.formatted()).monospacedDigit() } }
                Button("Copy diagnostics") { UIPasteboard.general.string = health.json; copied += 1 }
            } else if let message = page?.healthProblem ?? problem {
                ServiceProblem(message: message)
                Button("Retry") { Task { await load() } }
            } else {
                ForEach(0..<5, id: \.self) { _ in LabeledContent("Memory", value: "000 MB").redacted(reason: .placeholder) }
            }
        } header: { InsetHeader("ace health") }
    }

    private var resetSection: some View {
        Section {
            Button(resetting ? "Resetting…" : "Reset settings", role: .destructive) { confirmingReset = true }
                .disabled(resetting || model.connection != "ready").accessibilityIdentifier("diagnostics.reset")
            ServiceProblem(message: resetProblem)
        } footer: { Text("This machine's settings go back to their defaults. Appearance and notifications stay.") }
        .confirmationDialog("Reset all settings?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Reset settings", role: .destructive) { reset() }.accessibilityIdentifier("diagnostics.reset.confirm")
        } message: {
            Text("Defaults for new threads, shortcuts and thresholds are restored on this machine, for every device that uses it. Appearance, themes and notifications stay.")
        }
    }

    private func load() async {
        do {
            page = try await model.read(Self.read, as: HostDiagnosticsPage.self)
            problem = nil
        } catch is CancellationError {} catch { if !Task.isCancelled { problem = error.localizedDescription } }
    }
    private func runChecks() {
        checking = true; checksProblem = nil
        Task {
            defer { checking = false }
            do { checks = try await model.service(["type": "host.checks"], as: HostChecksReply.self, timeout: .seconds(16 * 60 + 30)) }
            catch is CancellationError {} catch { checksProblem = error.localizedDescription }
        }
    }
    private func export() {
        exporting = true; bundleProblem = nil
        Task {
            defer { exporting = false }
            do {
                let reply = try await model.service(["type": "host.support", "includeThreads": includeThreads], as: HostSupportReply.self, timeout: .seconds(90))
                guard let data = Data(base64Encoded: reply.data) else { throw ServiceFailure(message: "The support bundle didn't arrive whole. Try again.") }
                let url = FileManager.default.temporaryDirectory.appending(path: reply.name)
                try data.write(to: url, options: [.atomic, .completeFileProtection])
                bundle = url
            } catch is CancellationError {} catch { bundleProblem = error.localizedDescription }
        }
    }
    private func reset() {
        resetting = true; resetProblem = nil
        Task {
            defer { resetting = false }
            do {
                page = try await model.service(["type": "host.reset"], as: HostDiagnosticsPage.self)
                resets += 1
            } catch is CancellationError {} catch { resetProblem = error.localizedDescription }
        }
    }
}

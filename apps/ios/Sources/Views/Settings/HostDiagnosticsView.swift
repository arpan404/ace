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
    @State private var sharing = false
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
            if model.connection != "ready" {
                ProblemRow("Can’t reach this machine.", detail: "Checks, the support bundle and reset need it online.",
                           id: "diagnostics.offline") { model.retry(); Task { await load() } }
            }
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
        .smoothChange(checks)
        .smoothChange(page)
        .smoothChange(bundle)
        .sensoryFeedback(.success, trigger: copied)
        .sensoryFeedback(.success, trigger: resets)
        .navigationTitle("Diagnostics").navigationBarTitleDisplayMode(.inline)
        // The bundle holds logs and settings: it goes once shared, or when Diagnostics closes.
        .sheet(isPresented: $sharing) {
            if let bundle {
                ShareSheet(url: bundle) { discardBundle() }
                    .presentationDetents([.medium, .large]).ignoresSafeArea()
            }
        }
        .onDisappear { discardBundle() }
        .readWhenConnected(model, id: model.readGeneration(Self.read)) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private var checksSection: some View {
        Section {
            Button(checking ? "Checking…" : "Run checks") { runChecks() }
                .buttonStyle(.rowAction)
                .disabled(checking || model.connection != "ready").accessibilityIdentifier("diagnostics.run")
            if let checks {
                Text(checks.summary).accessibilityIdentifier("diagnostics.summary")
                ForEach(checks.rows) { row in
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                        HStack {
                            Text(row.label)
                            Spacer(minLength: AceDesign.Space.related)
                            StateLabel(status: StatusDisplay(label: row.word, token: row.status == "ok" ? "done" : "failed"))
                        }
                        Group {
                            Text(row.message)
                            if let fix = row.fix { Text(fix) }
                        }
                        .font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
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
                .onChange(of: includeThreads) { discardBundle() }
            if bundle != nil {
                Button("Share support bundle") { sharing = true }
                    .buttonStyle(.rowAction)
                    .transition(.opacity).accessibilityIdentifier("diagnostics.share")
            } else {
                Button(exporting ? "Exporting…" : "Export support bundle") { export() }
                    .buttonStyle(.rowAction)
                    .disabled(exporting || model.connection != "ready").accessibilityIdentifier("diagnostics.export")
            }
            ServiceProblem(message: bundleProblem)
        } header: { InsetHeader("Support bundle") } footer: {
            Text("Exports recent logs, checks and settings locally, with known secrets and personal paths removed. Conversations are excluded by default. Review the file before sharing.")
        }
    }

    @ViewBuilder private var healthSection: some View {
        Section {
            if let health = page?.health {
                ForEach(health.rows, id: \.self) { row in LabeledContent(row.label) { Text(row.value).monospacedDigit() } }
                ForEach(health.queues, id: \.self) { queue in LabeledContent(queue.name) { Text(queue.depth.formatted()).monospacedDigit() } }
                Button("Copy diagnostics") { UIPasteboard.general.string = health.json; copied += 1 }.buttonStyle(.rowAction)
            } else if page?.healthProblem == nil && problem == nil && model.connection == "ready" {
                ForEach(0..<5, id: \.self) { _ in LabeledContent("Memory", value: "000 MB").redacted(reason: .placeholder) }
            } else if model.connection == "ready", let message = problem ?? page?.healthProblem {
                ServiceProblem(message: message)
                Button("Try again") { Task { await load() } }.buttonStyle(.rowAction)
            } else {
                Text("Shows once this phone reaches the machine.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
        } header: { InsetHeader("ace health") }
    }

    private var resetSection: some View {
        Section {
            Button(resetting ? "Resetting…" : "Reset settings", role: .destructive) { confirmingReset = true }
                .buttonStyle(.rowAction)
                .disabled(resetting || model.connection != "ready").accessibilityIdentifier("diagnostics.reset")
            ServiceProblem(message: resetProblem)
        } footer: { Text("This machine's settings go back to their defaults. Appearance and notifications stay.") }
        .confirmationDialog("Reset all settings?", isPresented: $confirmingReset, titleVisibility: .visible) {
            Button("Reset settings", role: .destructive) { reset() }.accessibilityIdentifier("diagnostics.reset.confirm")
        } message: {
            Text("Defaults for new threads and thresholds are restored on this machine, for every device that uses it. This phone's shortcuts, appearance and notifications stay.")
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
                discardBundle()
                bundle = try SupportBundleFile.write(data, name: reply.name)
            } catch is CancellationError {} catch { bundleProblem = error.localizedDescription }
        }
    }
    private func discardBundle() {
        SupportBundleFile.discard(bundle)
        bundle = nil
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


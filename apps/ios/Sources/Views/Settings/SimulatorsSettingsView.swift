import SwiftUI

/// Settings › Simulators on one machine, as the web's page: its iOS Simulators and Android
/// emulators on or off for every thread (asking first before off), how Android emulators open,
/// then the tools they need with how to get a missing one. The rows come from the bridge's
/// `simulators` settings page and the tools from `simulators.tools` (`bridge/simulator-tools.ts`).
struct SimulatorsSettingsView: View {
    let model: ClientModel
    var body: some View {
        SettingsPageView(model: model, page: "simulators", title: "Simulators") {
            SimulatorToolsSection(model: model)
        }
    }
}

/// `simulators.tools`: each tool Ready or Not installed, with how to get it.
private struct SimulatorToolsReply: Decodable, Equatable {
    struct Row: Decodable, Equatable, Identifiable {
        struct Installer: Decodable, Equatable { let href: String; let label: String }
        struct Download: Decodable, Equatable { let label: String; let working: String; let failed: String }
        let id: String
        let name: String
        let ready: Bool
        let status: String
        let detail: String
        let installer: Installer?
        let download: Download?
    }
    let rows: [Row]
    let problem: String?
    let checkAgain: String
}
/// A `devices.request` answer: whether the machine did it.
private struct DeviceDone: Decodable { let ok: Bool }

private struct SimulatorToolsSection: View {
    let model: ClientModel
    @State private var tools: SimulatorToolsReply?
    @State private var checking = false
    @State private var downloading = false
    @State private var downloadProblem: String?
    /// The first read failed: nothing to show yet.
    @State private var problem: String?
    private static let read: [String: Any] = ["type": "simulators.tools"]

    var body: some View {
        Section {
            if let tools {
                ServiceProblem(message: tools.problem)
                ForEach(tools.rows) { row in toolRow(row) }
                ServiceProblem(message: downloadProblem)
                Button(tools.checkAgain) { Task { await check() } }
                    .disabled(checking || model.connection != "ready")
                    .accessibilityIdentifier("simulators.tools.check")
            } else if let problem {
                ServiceProblem(message: problem)
                Button("Retry") { Task { await check() } }
            } else {
                ForEach(0..<3, id: \.self) { _ in
                    HStack { Text("Simulator tool"); Spacer(); Text("Ready") }
                }
                .redacted(reason: .placeholder)
                .accessibilityHidden(true)
            }
        } header: { InsetHeader("Tools") }
        .insetRowBackground()
        .smoothChange(tools)
        .readWhenConnected(model, id: model.readGeneration(Self.read)) { await check() }
    }

    private func toolRow(_ row: SimulatorToolsReply.Row) -> some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.xxs) {
                Text(row.name)
                if !row.detail.isEmpty {
                    Text(row.detail).font(AceDesign.Typeface.meta).foregroundStyle(AceDesign.Ink.muted)
                }
                if let installer = row.installer, let url = URL(string: installer.href) {
                    Link(installer.label, destination: url).font(AceDesign.Typeface.meta).buttonStyle(.borderless)
                }
                if let download = row.download {
                    Button(downloading ? download.working : download.label) { Task { await install(download) } }
                        .font(AceDesign.Typeface.meta).buttonStyle(.borderless)
                        .disabled(downloading || !model.canOperate)
                        .accessibilityIdentifier("simulators.tools.download")
                }
            }
            Spacer(minLength: AceDesign.Space.related)
            StateLabel(status: StatusDisplay(label: row.status, token: row.ready ? "done" : "idle"))
        }
        .accessibilityIdentifier("simulators.tool.\(row.id)")
    }

    private func check() async {
        checking = true
        defer { checking = false }
        do {
            tools = try await model.service(Self.read, as: SimulatorToolsReply.self); problem = nil
        } catch {
            if !Task.isCancelled, tools == nil { problem = error.localizedDescription }
        }
    }

    /// ace's own simulator streaming, downloaded through the machine's devices channel, then read again.
    private func install(_ download: SimulatorToolsReply.Row.Download) async {
        downloading = true; downloadProblem = nil
        defer { downloading = false }
        let done = try? await model.service(["type": "devices.request", "operation": ["op": "tools.install"]], as: DeviceDone.self)
        if done?.ok != true { downloadProblem = download.failed }
        await check()
    }
}

import SwiftUI

/// Account › Updates: this iPhone's own update and the connected computer's. The phone checks the
/// App Store (or opens TestFlight); the computer updates itself, so its row shows what it runs.
struct AccountUpdatesSection: View {
    @State private var phone = PhoneUpdateModel.current
    let computerName: String?
    let computer: MachineAppUpdateInfo?
    let client: ClientModel?
    @State private var checked = false
    @State private var asking = false
    @State private var confirming = false
    @State private var problem: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            phoneRows
            if let computerName, let client { computerRows(computerName, client) }
        } header: {
            InsetHeader("Updates")
        }
        .insetRowBackground()
        .confirmationDialog(ComputerUpdate.question(machine: computerName ?? "this computer"),
                            isPresented: $confirming, titleVisibility: .visible) {
            if let version = client?.machineUpdate?.available {
                Button("Update when agents are idle") { start(version, mode: "idle", agents: nil) }
                    .accessibilityIdentifier("account.updates.computer.idle")
                Button("Update now", role: .destructive) { start(version, mode: "now", agents: workingAgents.count) }
                    .accessibilityIdentifier("account.updates.computer.now")
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(ComputerUpdate.nowDetail(workingAgents))
        }
    }

    @ViewBuilder private var phoneRows: some View {
        InsetRow(icon: .deviceMobile, title: "ace for iPhone \(phone.version) (\(phone.build))",
                 subtitle: phoneLine)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.updates.phone")
        switch phone.state {
        case .development:
            EmptyView()
        case .testFlight:
            Button { openURL(PhoneUpdate.testFlightURL) } label: { InsetRow("Check for updates", icon: .arrowClockwise) }
                .accessibilityIdentifier("account.updates.phone.check")
        case .idle, .upToDate, .failed:
            Button { Task { await phone.check() } } label: { InsetRow("Check for updates", icon: .arrowClockwise) }
                .accessibilityIdentifier("account.updates.phone.check")
        case .checking:
            InsetRow("Checking…", icon: .arrowClockwise)
                .accessibilityIdentifier("account.updates.phone.checking")
        case .available(let version, let url):
            Button { openURL(url) } label: { InsetRow("Update to \(version)", icon: .arrowCircleDown) }
                .accessibilityIdentifier("account.updates.phone.install")
        }
    }

    private var phoneLine: String? {
        switch phone.state {
        case .development: "Development build"
        case .testFlight: "TestFlight build"
        case .upToDate: "ace is up to date"
        case .failed: "Couldn’t check for updates. Try again."
        default: nil
        }
    }

    private var workingAgents: [String] {
        client?.inbox.values.filter { $0.status.token == "working" }.map(\.title) ?? []
    }

    @ViewBuilder private func computerRows(_ name: String, _ client: ClientModel) -> some View {
        let version = client.machineUpdate.flatMap { $0.known ? $0.version : nil } ?? computer?.version
        if let info = client.machineUpdate, info.known {
            let step = ComputerUpdate.step(info, machine: name, checked: checked, asking: asking)
            InsetRow(icon: .desktop, title: "\(name): ace \(info.version)", subtitle: line(step) ?? problem)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("account.updates.computer")
            switch step {
            case .check, .upToDate, .failed:
                Button { check() } label: { InsetRow("Check for updates", icon: .arrowClockwise) }
                    .accessibilityIdentifier("account.updates.computer.check")
            case .available(let next):
                Button { confirming = true } label: { InsetRow("Update to \(next)", icon: .arrowCircleDown) }
                    .accessibilityIdentifier("account.updates.computer.install")
            default:
                EmptyView()
            }
        } else if let version, !version.isEmpty, version != "Unknown" {
            InsetRow(icon: .desktop, title: "\(name): ace \(version)", subtitle: "Updates run on \(name)")
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("account.updates.computer")
        }
    }

    private func line(_ step: ComputerUpdateStep) -> String? {
        switch step {
        case .versionOnly, .check, .available: nil
        case .blocked(let words): words
        case .checking: "Checking…"
        case .upToDate: "ace is up to date"
        case .waiting: "Updating when agents are idle…"
        case .downloading(let percent): percent.map { "Downloading… \($0)%" } ?? "Downloading…"
        case .restarting: "Restarting…"
        case .failed(let words): words
        }
    }

    private func check() {
        guard let client else { return }
        asking = true; problem = nil; checked = false
        Task {
            defer { asking = false }
            do {
                let info = try await client.service(["type": "machine.update.check"], as: MachineUpdateInfo.self)
                checked = info.available == nil
            } catch is CancellationError {
            } catch { problem = error.localizedDescription }
        }
    }

    private func start(_ version: String, mode: String, agents: Int?) {
        guard let client else { return }
        problem = nil
        var request: [String: Any] = ["type": "machine.update.start", "version": version, "mode": mode]
        if let agents { request["agents"] = agents }
        Task {
            do { _ = try await client.service(request, as: MachineUpdateInfo.self) }
            catch is CancellationError {}
            catch { problem = error.localizedDescription }
        }
    }
}

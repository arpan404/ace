import SwiftUI

/// Account › Updates: this iPhone's own update and the connected computer's. The phone checks the
/// App Store (or opens TestFlight); the computer updates itself, so its row shows what it runs.
struct AccountUpdatesSection: View {
    @State private var phone = PhoneUpdateModel.current
    let computerName: String?
    let computer: MachineAppUpdateInfo?
    @Environment(\.openURL) private var openURL

    var body: some View {
        Section {
            phoneRows
            if let computerName, let computer, computer.known { computerRows(computerName, computer) }
        } header: {
            InsetHeader("Updates")
        }
        .insetRowBackground()
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

    @ViewBuilder private func computerRows(_ name: String, _ info: MachineAppUpdateInfo) -> some View {
        InsetRow(icon: .desktop, title: "\(name): ace \(info.version)", subtitle: info.line ?? "Updates run on \(name)")
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("account.updates.computer")
    }
}

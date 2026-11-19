import Foundation
import Observation

/// `--spike-account`'s machines on Profile, where a real launch has a `MachinesModel`: listed and
/// forgotten on the fixture's fake account backend (`scripts/spike-account.ts`) through the app's
/// own `AceAccountAPI`, so a UI test sees the requests Profile really sends.
@MainActor @Observable final class SpikeAccountMachines {
    private(set) var machines: [AceMachine] = []
    private let api: AceAccountAPI
    private let token: String

    init(api: AceAccountAPI, token: String) {
        self.api = api
        self.token = token
    }

    /// Nil unless the launch asked for `--spike-account`.
    static func make() -> SpikeAccountMachines? {
        SpikeConfiguration.accountOrigin.map { SpikeAccountMachines(api: AceAccountAPI(origin: $0), token: SpikeConfiguration.accountToken) }
    }

    func load() async {
        if let listed = try? await api.machines(token: token) { machines = listed }
    }

    /// As `MachinesModel.forgetAccountMachine` does for an account machine: nil when done.
    func forget(_ hostId: String) async -> ProblemNotice? {
        do { try await api.forget(token: token, hostId: hostId) }
        catch { return ProblemNotice(code: "account", message: "Couldn't forget this machine. Check your connection and try again.") }
        machines.removeAll { $0.hostId == hostId }
        return nil
    }
}

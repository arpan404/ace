import SwiftUI

/// The review before an install or an update (#2501 fills it), as a sheet titled "Get <title>":
/// prepared on the daemon, every page read before Install is enabled, cancelled when dismissed
/// without installing. `done` gets what landed.
struct MarketReviewSheet: View {
    enum Mode: Hashable {
        /// Get: a listed entry onto this machine.
        case install(MarketEntryKey)
        /// Update an installed entry (a bot made from a package, by its bot).
        case update(MarketInstalledKey)
    }
    let model: ClientModel
    let mode: Mode
    let machineName: String
    let done: (MarketInstall?) -> Void

    var body: some View {
        EmptyState(icon: .storefront, title: "Review")
            .frame(maxHeight: .infinity)
    }
}

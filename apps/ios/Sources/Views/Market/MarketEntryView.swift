import SwiftUI

/// An entry's page (#2501 fills it): picture or face, title, one line, publisher, the one action
/// (Get, Update, Installed or why it can't), what it may do, versions and source.
struct MarketEntryView: View {
    let model: ClientModel
    let entry: MarketEntryKey
    /// The machine it installs onto, by name ("Install on arpan-mbp").
    let machineName: String

    var body: some View {
        EmptyState(icon: .storefront, title: entry.name)
            .frame(maxHeight: .infinity)
    }
}

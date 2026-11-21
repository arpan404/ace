import SwiftUI

/// Everything installed from the market on this machine (#2502 fills it): updates first, each
/// row's type, version and state, swipe to remove or turn back on, pull to refresh.
struct MarketInstalledView: View {
    let model: ClientModel
    let machineName: String

    var body: some View {
        EmptyState(icon: .storefront, title: "Installed")
            .frame(maxHeight: .infinity)
            .navigationTitle("Installed")
    }
}

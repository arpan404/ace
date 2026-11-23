import SwiftUI

/// Where the Marketplace goes from its home: an entry's page, Installed, one of Browse's
/// pages, or the publisher's own listings. Each market screen holds its own `route` and pushes with `marketRoutes`, so the pages
/// stack inside whichever navigation stack shows the Marketplace (Search's, or Settings' sheet).
enum MarketRoute: Hashable, Identifiable {
    case entry(MarketEntryKey)
    case installed
    case browse(MarketBrowsePage)
    /// The signed-in publisher's own listings, drafts and profile (#2554).
    case yours
    /// One of the publisher's own listings, to manage.
    case manage(type: String, name: String)
    var id: Self { self }
}

/// Browse's pages past the home (#2500): search with a type filter, a category, a publisher's
/// page and the sources.
enum MarketBrowsePage: Hashable {
    /// `type` is `spade-bot`, `spade-skill`, `spade-plugin` or `suit`; nil for Everything.
    case search(type: String?)
    case category(id: String, title: String)
    case publisher(handle: String)
    case sources
}

extension View {
    /// Pushes `route` when set, on `model`'s machine, named `machineName` where an install says
    /// where it lands.
    func marketRoutes(_ route: Binding<MarketRoute?>, model: ClientModel, machineName: String) -> some View {
        navigationDestination(item: route) { MarketRouteView(route: $0, model: model, machineName: machineName) }
    }
}

/// The page a route opens. Each case is its slice's own view, so this switch stays as it is.
struct MarketRouteView: View {
    let route: MarketRoute
    let model: ClientModel
    let machineName: String

    var body: some View {
        switch route {
        case .entry(let key): MarketEntryView(model: model, entry: key, machineName: machineName)
        case .installed: MarketInstalledView(model: model, machineName: machineName)
        case .browse(let page): MarketBrowseView(model: model, page: page, machineName: machineName)
        case .yours: MarketManageView(model: model, machineName: machineName)
        case .manage(let type, let name): MarketManageListing(model: model, type: type, name: name)
        }
    }
}

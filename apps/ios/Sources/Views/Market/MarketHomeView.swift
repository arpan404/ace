import SwiftUI

/// The Marketplace's home on one machine (#2500 fills it): Discover's shelves, search, the type
/// filter and categories. Until then it is the shell: what this phone last kept, read again when
/// the market changes, and the way to Installed with how many updates wait.
struct MarketHomeView: View {
    let model: ClientModel
    /// The machine the market is on, by name: where an install lands.
    let machineName: String
    @State private var home: MarketHome?
    @State private var problem: MarketRefusal?
    @State private var route: MarketRoute?

    init(model: ClientModel, machineName: String) {
        self.model = model
        self.machineName = machineName
        _home = State(initialValue: model.keptMarketHome)
    }

    var body: some View {
        List {
            Section {
                Button { route = .installed } label: {
                    InsetRow("Installed", icon: .storefront, value: home?.updatesText)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("market.installed")
            }
            if let problem, home == nil {
                EmptyState(icon: nil, title: problem.message, failed: true)
                    .listRowBackground(Color.clear)
            }
        }
        .marketRoutes($route, model: model, machineName: machineName)
        .task(id: model.marketGeneration) { await load() }
    }

    private func load() async {
        do {
            home = try await model.marketHome()
            problem = nil
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}

/// Browse's pages past the home (#2500): search, a category, a publisher, the sources.
struct MarketBrowseView: View {
    let model: ClientModel
    let page: MarketBrowsePage
    let machineName: String

    var body: some View {
        EmptyState(icon: .storefront, title: "Browse")
            .frame(maxHeight: .infinity)
    }
}

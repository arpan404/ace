import SwiftUI

/// Your listings (#2554): the signed-in publisher's profile, each listing with its version,
/// state, installs and open reports, and the drafts still to finish. Publish starts a new one;
/// a listing opens its versions and signals; the profile opens its editor and the public page as
/// others see it. Signed out, it says to sign in to publish; with no profile yet, it makes one.
struct MarketManageView: View {
    let model: ClientModel
    let machineName: String
    @State private var page: MarketMePage?
    @State private var problem: MarketRefusal?
    @State private var route: MarketRoute?
    @State private var publishing = false
    @State private var editing = false

    private var offline: Bool { model.connection != "ready" }

    var body: some View {
        List {
            if let problem {
                Section {
                    ProblemRow(problem.message, detail: problem.reason, id: "market.manage.problem",
                               retry: problem.code == "signed_out" ? nil : { Task { await load() } })
                }
                .insetRowBackground()
            }
            if let page {
                profileSection(page)
                if page.profile != nil {
                    listingsSection(page)
                    draftsSection(page)
                }
            } else if problem == nil {
                Section { SkeletonRows(count: 4, label: "Reading your listings").listRowInsets(EdgeInsets()) }
            }
        }
        .insetGroupedList()
        .navigationTitle("Your listings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if page?.profile != nil, page?.suspended == false {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { publishing = true } label: { Image(bar: .trayArrowUp) }
                        .barGlyph()
                        .disabled(offline || !model.canOperate)
                        .accessibilityLabel("Publish")
                        .accessibilityIdentifier("market.manage.publish")
                }
            }
        }
        .marketRoutes($route, model: model, machineName: machineName)
        .sheet(isPresented: $publishing) {
            MarketPublishView(model: model) { Task { await load() } }
        }
        .sheet(isPresented: $editing) {
            MarketProfileEdit(model: model, profile: page?.profile) { _ in Task { await load() } }
        }
        .task(id: model.marketGeneration) { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func profileSection(_ page: MarketMePage) -> some View {
        Section {
            if let profile = page.profile {
                Button { editing = true } label: {
                    InsetRow(profile.name, icon: .userCircle, subtitle: "@\(profile.handle)")
                }
                .buttonStyle(.row)
                .disabled(offline || !model.canOperate)
                .accessibilityHint("Edits your publisher profile")
                .accessibilityIdentifier("market.manage.profile")
                Button { route = .browse(.publisher(handle: profile.handle)) } label: {
                    InsetRow("Your public page", icon: .store)
                }
                .buttonStyle(.row)
                .accessibilityIdentifier("market.manage.publicPage")
            } else {
                Button { editing = true } label: { AddRow("Make your publisher profile") }
                    .disabled(offline || !model.canOperate)
                    .accessibilityIdentifier("market.manage.createProfile")
            }
        } footer: {
            if page.suspended { Text("Your publisher account is suspended.") } else { Text(page.limitText) }
        }
        .insetRowBackground()
    }

    @ViewBuilder private func listingsSection(_ page: MarketMePage) -> some View {
        Section {
            if page.listings.isEmpty {
                Text("Nothing published yet.").aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
            }
            ForEach(page.listings) { listing in
                Button { route = .manage(type: listing.type, name: listing.name) } label: {
                    InsetRow(listing.title, icon: nil,
                             subtitle: [listing.typeWord, listing.statusText, listing.downloadsText, listing.reportsText]
                                .compactMap { $0 }.joined(separator: " · "))
                }
                .buttonStyle(.row)
                .accessibilityIdentifier("market.manage.listing.\(listing.id)")
            }
        } header: { InsetHeader("Listings") }
        .insetRowBackground()
    }

    @ViewBuilder private func draftsSection(_ page: MarketMePage) -> some View {
        if !page.drafts.isEmpty {
            Section {
                ForEach(page.drafts) { draft in
                    InsetRow(draft.title, icon: nil, subtitle: "\(draft.typeWord) · \(draft.version) · \(draft.stateText)")
                        .accessibilityIdentifier("market.manage.draft.\(draft.id)")
                }
            } header: { InsetHeader("Drafts") }
            .insetRowBackground()
        }
    }

    private func load() async {
        do {
            page = try await model.marketMe()
            problem = nil
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }
}

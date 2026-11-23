import SwiftUI

/// One of the publisher's listings (#2554): its versions with their state and installs, its
/// signals (installs in the last 30 days, how many are on the latest, reports), and Withdraw,
/// for one version or the whole listing, behind a confirm that asks why. Anyone who installed a
/// withdrawn version sees it as withdrawn, with that reason.
struct MarketManageListing: View {
    let model: ClientModel
    let type: String
    let name: String
    @State private var listing: MarketManagedListing?
    @State private var problem: MarketRefusal?
    @State private var said: String?
    /// The withdrawal being asked about: a version, or nil inside for the whole listing.
    @State private var withdrawing: Withdrawal?
    @State private var reason = ""
    @State private var working = false
    @State private var withdrawn = 0

    struct Withdrawal: Identifiable, Hashable {
        let version: String?
        var id: String { version ?? "" }
    }

    private var held: Bool { model.connection != "ready" || !model.canOperate || working }

    var body: some View {
        List {
            if let problem {
                Section {
                    if problem.asksForPerson {
                        MarketConfirmPerson(refusal: problem, hostId: model.hostId, busy: working) { Task { await withdraw(confirmed: true) } }
                    } else {
                        ProblemRow(problem.message, detail: problem.reason, id: "market.manage.listing.problem") { Task { await load() } }
                    }
                }
                .insetRowBackground()
            }
            if let said {
                Section { Text(said).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted) }
                    .insetRowBackground()
            }
            if let listing {
                summary(listing)
                versions(listing)
                signals(listing)
                if listing.withdrawable {
                    Section {
                        Button("Withdraw the listing", role: .destructive) { ask(nil) }
                            .disabled(held)
                            .accessibilityIdentifier("market.manage.withdrawAll")
                    }
                    .insetRowBackground()
                }
            } else if problem == nil && said == nil {
                Section { SkeletonRows(count: 4, label: "Reading the listing").listRowInsets(EdgeInsets()) }
            }
        }
        .insetGroupedList()
        .navigationTitle(listing?.title ?? "Listing")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .refreshable { await load() }
        .sensoryFeedback(.warning, trigger: withdrawn)
        .alert(withdrawing?.version.map { "Withdraw \($0)?" } ?? "Withdraw the listing?",
               isPresented: Binding(get: { withdrawing != nil && problem?.asksForPerson != true },
                                    set: { if !$0 { withdrawing = nil } }),
               presenting: withdrawing) { _ in
            TextField("Why", text: $reason)
                .accessibilityIdentifier("market.manage.withdraw.reason")
            Button("Withdraw", role: .destructive) { Task { await withdraw(confirmed: false) } }
                .disabled(reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("market.manage.withdraw.confirm")
            Button("Cancel", role: .cancel) { withdrawing = nil }
        } message: { _ in
            Text("Anyone who installed it sees it as withdrawn, with your reason.")
        }
    }

    private func summary(_ listing: MarketManagedListing) -> some View {
        Section {
            InsetRow(listing.typeWord, icon: nil, value: listing.statusText)
            InsetRow("Installs", icon: nil, value: listing.downloadsText)
            if listing.pendingListing {
                Text("A change to the listing is waiting for review.").aceFont(AceDesign.TextRole.meta)
                    .foregroundStyle(AceTheme.StatusText.waiting)
            }
        }
        .insetRowBackground()
    }

    private func versions(_ listing: MarketManagedListing) -> some View {
        Section {
            ForEach(listing.versions) { version in
                VStack(alignment: .leading, spacing: AceDesign.Size.rowLineGap) {
                    HStack {
                        Text(version.version).aceFont(AceDesign.TextRole.rowTitle).foregroundStyle(AceDesign.Ink.primary)
                        Spacer(minLength: AceDesign.Space.related)
                        Text(version.statusText).aceFont(AceDesign.TextRole.meta)
                            .foregroundStyle(version.status == "withdrawn" || version.status == "blocked"
                                             ? AceTheme.StatusText.failed : AceDesign.Ink.muted)
                    }
                    Text("\(version.dateText) · \(version.downloadsText)").aceFont(AceDesign.TextRole.meta)
                        .foregroundStyle(AceDesign.Ink.muted)
                    if let reason = version.reason {
                        Text(reason).aceFont(AceDesign.TextRole.meta).foregroundStyle(AceDesign.Ink.muted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, AceDesign.Space.tight)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("market.manage.version.\(version.version)")
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                    if version.withdrawable, !held {
                        Button("Withdraw", ace: .prohibit, role: .destructive) { ask(version.version) }
                    }
                }
                .contextMenu {
                    if version.withdrawable, !held {
                        Button("Withdraw \(version.version)", ace: .prohibit, role: .destructive) { ask(version.version) }
                    }
                }
            }
        } header: { InsetHeader("Versions") }
        .insetRowBackground()
    }

    @ViewBuilder private func signals(_ listing: MarketManagedListing) -> some View {
        if let signals = listing.signals {
            Section {
                InsetRow("Installs", icon: .chartBar, value: signals.downloadsText)
                if let adoption = signals.adoptionText { InsetRow("On the latest", icon: .arrowCircleUp, value: adoption) }
                ForEach(signals.reports) { report in
                    InsetRow(report.reasonText, icon: .warning, value: report.stateText, subtitle: report.dateText)
                }
            } header: { InsetHeader("Signals") }
            .insetRowBackground()
        }
    }

    private func ask(_ version: String?) {
        reason = ""
        problem = nil
        withdrawing = Withdrawal(version: version)
    }

    private func load() async {
        do {
            listing = try await model.marketManaged(type: type, name: name)
            problem = nil
        } catch let refusal as MarketRefusal {
            problem = refusal
        } catch {}
    }

    /// Withdraws what `withdrawing` names. Refused for standing, the question stays answered
    /// and Confirm it's you sends the same withdrawal once more.
    private func withdraw(confirmed: Bool) async {
        guard let asked = withdrawing, !working else { return }
        working = true
        defer { working = false }
        do {
            let answer = try await model.marketWithdraw(type: type, name: name, version: asked.version,
                                                        reason: reason, confirmed: confirmed)
            listing = answer.listing
            said = answer.message
            problem = nil
            withdrawing = nil
            withdrawn += 1
        } catch let refusal as MarketRefusal {
            problem = refusal
            if !refusal.asksForPerson { withdrawing = nil }
        } catch {}
    }
}

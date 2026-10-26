import SwiftUI

/// The web list toolbar's choices in one native menu: State (with GitHub's counts), Involvement
/// and Sort, then the Filters menu's narrowing choices (drafts, review, checks, author, labels)
/// and Clear. The chip names the state on show and how many narrowing choices are on.
struct ForgeFiltersMenu: View {
    let kind: ForgeKind
    @Binding var pulls: PullsFilter
    @Binding var issues: IssuesFilter
    let pullList: ForgePullList?
    let issueList: ForgeIssueList?

    var body: some View {
        Menu {
            switch kind {
            case .pulls: pullChoices
            case .issues: issueChoices
            case .inbox: EmptyView()
            }
        } label: { InboxChip(title: title) }
            .accessibilityIdentifier("forge.filters")
            .accessibilityLabel("Filters, \(title)")
    }

    private var title: String {
        switch kind {
        case .pulls:
            let state = PullsFilter.states.first { $0.0 == pulls.state }?.1 ?? "Open"
            return pulls.narrowing > 0 ? "\(state) · \(pulls.narrowing)" : state
        case .issues:
            let state = IssuesFilter.states.first { $0.0 == issues.state }?.1 ?? "Open"
            return issues.narrowing > 0 ? "\(state) · \(issues.narrowing)" : state
        case .inbox:
            return ""
        }
    }

    @ViewBuilder private var pullChoices: some View {
        let counts = pullList?.counts
        Picker("State", selection: $pulls.state) {
            ForEach(PullsFilter.states, id: \.0) { value, label in
                let count = value == "open" ? counts?.open : value == "merged" ? counts?.merged : value == "closed" ? counts?.closed : nil
                Text(count.map { "\(label)  \($0.formatted())" } ?? label).tag(value)
            }
        }
        Picker("Involvement", selection: $pulls.who) {
            ForEach(PullsFilter.involvement, id: \.0) { Text($1).tag($0) }
        }
        Menu("Sort") {
            Picker("Sort", selection: $pulls.sort) { ForEach(PullsFilter.sorts, id: \.0) { Text($1).tag($0) } }
        }
        Section("Filters") {
            Menu("Drafts") { optional($pulls.draft, PullsFilter.drafts) }
            Menu("Review") { optional($pulls.review, PullsFilter.reviews) }
            Menu("Checks") { optional($pulls.checks, PullsFilter.checkChoices) }
            authors($pulls.author, pullList?.authors ?? [])
            labels($pulls.labels, pullList?.labels ?? [])
            if pulls.narrowing > 0 {
                Button("Clear filters", role: .destructive) {
                    pulls.draft = nil; pulls.review = nil; pulls.checks = nil; pulls.author = nil; pulls.labels = []
                }
            }
        }
    }

    @ViewBuilder private var issueChoices: some View {
        let counts = issueList?.counts
        Picker("State", selection: $issues.state) {
            ForEach(IssuesFilter.states, id: \.0) { value, label in
                let count = value == "open" ? counts?.open : counts?.closed
                Text(count.map { "\(label)  \($0.formatted())" } ?? label).tag(value)
            }
        }
        Picker("Involvement", selection: $issues.who) {
            ForEach(IssuesFilter.involvement, id: \.0) { Text($1).tag($0) }
        }
        Menu("Sort") {
            Picker("Sort", selection: $issues.sort) { ForEach(IssuesFilter.sorts, id: \.0) { Text($1).tag($0) } }
        }
        Section("Filters") {
            authors($issues.author, issueList?.authors ?? [])
            labels($issues.labels, issueList?.labels ?? [])
            if issues.narrowing > 0 {
                Button("Clear filters", role: .destructive) { issues.author = nil; issues.labels = [] }
            }
        }
    }

    /// One choice of several where the first ("") is none.
    private func optional(_ value: Binding<String?>, _ choices: [(String, String)]) -> some View {
        Picker("", selection: Binding(get: { value.wrappedValue ?? "" }, set: { value.wrappedValue = $0.isEmpty ? nil : $0 })) {
            ForEach(choices, id: \.0) { Text($1).tag($0) }
        }
        .pickerStyle(.inline)
    }

    private func authors(_ value: Binding<String?>, _ logins: [String]) -> some View {
        Menu("Author") {
            optional(value, [("", "Anyone")] + logins.map { ($0, $0) })
        }
    }

    @ViewBuilder private func labels(_ value: Binding<[String]>, _ names: [String]) -> some View {
        if !names.isEmpty {
            Menu("Labels") {
                ForEach(names, id: \.self) { name in
                    Toggle(name, isOn: Binding(
                        get: { value.wrappedValue.contains(name) },
                        set: { on in
                            if on { if value.wrappedValue.count < 20 { value.wrappedValue.append(name) } }
                            else { value.wrappedValue.removeAll { $0 == name } }
                        }))
                }
            }
        }
    }
}

import SwiftUI

/// Who reviews a new pull request and how it is filed, as the web's New pull request page sets
/// them: reviewers, assignees and labels each open a list to pick from, the milestone is a menu.
/// The choices are the repository's (`forge.repo.pr-options`), read with the branches.
struct ForgeNewPullDetailsSection: View {
    let details: ForgeNewPrContext.Details
    @Binding var draft: ForgeNewPrDetailsDraft

    var body: some View {
        QuietSection("Details") {
            pickRow("Reviewers", picked: draft.reviewers, identifier: "forge.newpr.reviewers") {
                ForgePickList(title: "Reviewers", choices: people, most: details.most.reviewers, picked: $draft.reviewers)
            }
            pickRow("Assignees", picked: draft.assignees, identifier: "forge.newpr.assignees") {
                ForgePickList(title: "Assignees", choices: people, most: details.most.assignees, picked: $draft.assignees)
            }
            pickRow("Labels", picked: draft.labels, identifier: "forge.newpr.labels") {
                ForgePickList(title: "Labels", choices: labels, most: details.most.labels, picked: $draft.labels)
            }
            milestoneRow
        }
    }

    private var people: [ForgePickList.Choice] { details.people.map { ForgePickList.Choice(value: $0) } }
    private var labels: [ForgePickList.Choice] {
        details.labels.map { ForgePickList.Choice(value: $0.name, detail: $0.description, color: $0.color) }
    }

    private func pickRow<Page: View>(_ title: String, picked: [String], identifier: String,
                                     @ViewBuilder page: @escaping () -> Page) -> some View {
        NavigationLink { page() } label: {
            QuietSectionRow {
                Text(title).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout).foregroundStyle(AceDesign.Ink.primary)
                Spacer(minLength: AceDesign.Space.related)
                Text(picked.isEmpty ? "None" : picked.joined(separator: ", "))
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(picked.isEmpty ? AceDesign.Ink.subtle : AceDesign.Ink.muted)
                    .lineLimit(1).truncationMode(.tail)
                RowCaret()
            }
        }
        .buttonStyle(.row)
        .accessibilityIdentifier(identifier)
    }

    private var milestoneRow: some View {
        QuietSectionRow {
            Text("Milestone").aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout).foregroundStyle(AceDesign.Ink.primary)
            Spacer(minLength: AceDesign.Space.related)
            Menu {
                Picker("Milestone", selection: $draft.milestone) {
                    Text("No milestone").tag(Int?.none)
                    // A menu row's second line is its due date, as the web's hint.
                    ForEach(details.milestones, id: \.number) { each in
                        VStack { Text(each.title); if let due = each.due { Text(due) } }.tag(Optional(each.number))
                    }
                }
            } label: {
                Text(details.milestones.first { $0.number == draft.milestone }?.title ?? "None")
                    .aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(draft.milestone == nil ? AceDesign.Ink.subtle : AceDesign.Ink.muted)
                    .lineLimit(1)
            }
            .disabled(details.milestones.isEmpty)
            .accessibilityIdentifier("forge.newpr.milestone")
        }
    }
}

/// A page of choices with a check beside each picked one, searchable, in the order GitHub lists
/// them. Past `most` picks the rest wait until one is taken off.
struct ForgePickList: View {
    struct Choice: Identifiable, Hashable {
        let value: String
        var detail: String? = nil
        /// A label's colour, six hex digits.
        var color: String? = nil
        var id: String { value }
    }
    let title: String
    let choices: [Choice]
    let most: Int
    @Binding var picked: [String]
    @State private var query = ""

    private var shown: [Choice] {
        let typed = query.trimmingCharacters(in: .whitespaces)
        return typed.isEmpty ? choices : choices.filter { $0.value.localizedCaseInsensitiveContains(typed) }
    }

    var body: some View {
        List {
            if shown.isEmpty {
                EmptyState(icon: nil, title: query.isEmpty ? "Nothing to pick" : "Nothing matches", line: nil)
                    .listRowBackground(Color.clear)
            }
            ForEach(shown) { choice in
                let on = picked.contains(choice.value)
                Button { toggle(choice.value) } label: {
                    HStack(spacing: AceDesign.Space.related) {
                        if let color = choice.color {
                            Circle().fill(Color(uiColor: UIColor(hex: color))).frame(width: AceDesign.Size.dot, height: AceDesign.Size.dot)
                                .accessibilityHidden(true)
                        }
                        QuietRowText(title: choice.value, detail: choice.detail)
                        if on { Image(systemName: "checkmark").foregroundStyle(AceDesign.Ink.primary).accessibilityHidden(true) }
                    }
                    .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.row)
                .disabled(!on && picked.count >= most)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("forge.pick.\(choice.value)")
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(AceDesign.Surface.background)
        .searchable(text: $query, prompt: "Search \(title.lowercased())")
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func toggle(_ value: String) {
        if let index = picked.firstIndex(of: value) { picked.remove(at: index) }
        else if picked.count < most { picked.append(value) }
    }
}

import SwiftUI

/// New pull request from any branch of the project (the web's New pull request page): the branch
/// to merge into and the one it comes from, what it would hold, then its title, description (the
/// repository's template to start), who reviews it and how it is filed, and Draft. Create opens
/// it; branches that already have an open pull request open that one instead, never a second.
/// When GitHub opened it without all of its details (or found the branches' own), the sheet stays
/// on what happened, with Open, as the web's warning says it.
struct ForgeNewPullSheet: View {
    let client: ClientModel
    let project: String
    let opened: (Int) -> Void
    @State private var context: ForgeNewPrContext?
    @State private var failure: String?
    @State private var base = ""
    @State private var head = ""
    @State private var compare: ForgeNewPrCompare?
    @State private var title = ""
    @State private var body_ = ""
    @State private var draft = false
    /// Reviewers, assignees, labels and milestone: kept while branches are switched, as the web's.
    @State private var details = ForgeNewPrDetailsDraft()
    @State private var creating = false
    @State private var message: String?
    /// The pull request opened, with what GitHub said about it, shown before it opens.
    @State private var done: (number: Int, notice: ForgeNewPrCreated.Notice)?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if let done { doneView(done.number, done.notice) }
                else if let context { form(context) }
                else if let failure {
                    EmptyState(icon: nil, title: "Couldn't read the branches", line: failure, failed: true) {
                        Button("Try again") { Task { await load() } }
                    }
                } else { SkeletonPage(label: "Reading the branches") }
            }
            .background(AceTheme.Colours.background)
            .navigationTitle("New pull request")
            .navigationBarTitleDisplayMode(.inline)
            // Once it opened there's nothing to cancel: the sheet closes on the list.
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(done == nil ? "Cancel" : "Done") { dismiss() } } }
        }
        .task { await load() }
        .task(id: "\(base)|\(head)") { await compareBranches() }
    }

    private func form(_ context: ForgeNewPrContext) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: AceTheme.Spacing.lg) {
                ForgeSection(title: nil) {
                    pickerRow("Into", selection: $base, choices: context.bases, identifier: "forge.newpr.base")
                    pickerRow("From", selection: $head, choices: context.head.branches, identifier: "forge.newpr.head")
                }
                if let opensOn = context.opensOn {
                    Text(opensOn).meta().lineLimit(1).truncationMode(.middle)
                        .padding(.horizontal, AceTheme.Spacing.lg)
                        .accessibilityIdentifier("forge.newpr.repository")
                }
                if let compare {
                    VStack(alignment: .leading, spacing: AceTheme.Spacing.xs) {
                        Text(compare.blocked ?? compare.summary).meta().lineLimit(2)
                        if let existing = compare.existing {
                            Button("Open #\(existing)") { opened(existing); dismiss() }
                                .aceFont(AceTheme.Typography.caption, relativeTo: .footnote)
                        }
                    }
                    .padding(.horizontal, AceTheme.Spacing.lg)
                }
                VStack(alignment: .leading, spacing: AceTheme.Spacing.sm) {
                    TextField("Title", text: $title)
                        .aceFont(AceTheme.Typography.body, relativeTo: .body)
                        .padding(AceTheme.Spacing.md)
                        .background(AceTheme.Colours.fill, in: AceDesign.Shape.field)
                        .accessibilityIdentifier("forge.newpr.title")
                    ForgeEditor(text: $body_, placeholder: "Description", minLines: 4,
                                completer: ForgeCompleter(client: client, project: project, repository: context.repository, on: nil))
                }
                .padding(.horizontal, AceTheme.Spacing.lg)
                if let options = context.details { ForgeNewPullDetailsSection(details: options, draft: $details) }
                Toggle("Draft", isOn: $draft).aceFont(AceTheme.Typography.label, relativeTo: .subheadline)
                    .padding(.horizontal, AceTheme.Spacing.lg)
                if let message {
                    Text(message).aceFont(AceTheme.Typography.caption, relativeTo: .footnote).foregroundStyle(AceTone.failed.text)
                        .padding(.horizontal, AceTheme.Spacing.lg)
                }
            }
            .padding(.vertical, AceTheme.Spacing.md)
        }
        .safeAreaInset(edge: .bottom, spacing: AceTheme.Spacing.none) {
            Button { create(context) } label: {
                HStack {
                    if creating { ProgressView().controlSize(.small) }
                    Text(draft ? "Create draft pull request" : "Create pull request").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity, minHeight: AceDesign.Size.tap)
            }
            .buttonStyle(.textAction(.prominent))
            .disabled(!canCreate)
            .padding(.horizontal, AceTheme.Spacing.lg).padding(.vertical, AceTheme.Spacing.sm)
            .background(AceTheme.Colours.background)
            .accessibilityIdentifier("forge.newpr.create")
        }
    }

    private func doneView(_ number: Int, _ notice: ForgeNewPrCreated.Notice) -> some View {
        VStack(alignment: .leading, spacing: AceDesign.Space.related) {
            Text(notice.title).aceFont(AceDesign.TextRole.rowTitle, relativeTo: .callout).foregroundStyle(AceDesign.Ink.primary)
                .accessibilityIdentifier("forge.newpr.done")
            if let detail = notice.detail {
                Text(detail).aceFont(AceDesign.TextRole.meta, relativeTo: .footnote)
                    .foregroundStyle(notice.warning ? AceTheme.StatusText.needsYou : AceDesign.Ink.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("forge.newpr.warning")
            }
            Button("Open #\(number)") { opened(number); dismiss() }
                .buttonStyle(.textAction(.prominent))
                .accessibilityIdentifier("forge.newpr.openCreated")
            Spacer()
        }
        .padding(.horizontal, AceDesign.Space.margin)
        .padding(.top, AceDesign.Space.group)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func pickerRow(_ label: String, selection: Binding<String>, choices: [String], identifier: String) -> some View {
        HStack {
            Text(label).aceFont(AceTheme.Typography.label, relativeTo: .subheadline).fontWeight(.regular)
                .foregroundStyle(AceTheme.Colours.foreground)
            Spacer(minLength: AceTheme.Spacing.sm)
            Menu {
                Picker(label, selection: selection) { ForEach(choices, id: \.self) { Text($0).tag($0) } }
            } label: {
                Text(selection.wrappedValue.isEmpty ? "Choose a branch" : selection.wrappedValue)
                    .aceMonospace(AceTheme.Typography.caption, relativeTo: .footnote)
                    .foregroundStyle(AceTheme.Colours.mutedForeground).lineLimit(1)
            }
            .accessibilityIdentifier(identifier)
        }
        .padding(.horizontal, AceTheme.Spacing.lg).frame(minHeight: AceDesign.Size.tap)
    }

    private var canCreate: Bool {
        !creating && client.canOperate && !head.isEmpty && compare != nil && compare?.blocked == nil && compare?.existing == nil
            && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func headJSON(_ context: ForgeNewPrContext) -> [String: Any] {
        ["owner": context.head.owner, "name": context.head.name, "branch": head]
    }

    private func load() async {
        do {
            let read = try await client.forgeNewPrContext(project: project)
            if context == nil { base = read.defaultBranch; body_ = read.template }
            context = read
            failure = nil
        } catch is CancellationError {
        } catch { failure = error.localizedDescription }
    }

    private func compareBranches() async {
        guard let context, !head.isEmpty, !base.isEmpty else { compare = nil; return }
        compare = try? await client.forgeNewPrCompare(project: project, repository: context.repository, base: base, head: headJSON(context))
        // A branch's newest commit is the title GitHub would suggest.
        if title.isEmpty, let last = compare?.commits.last { title = last.title }
    }

    private func create(_ context: ForgeNewPrContext) {
        creating = true
        Task {
            let outcome = await client.forgeNewPrCreate(project: project, repository: context.repository, base: base, head: headJSON(context),
                                                        title: title, body: body_, draft: draft, details: details)
            creating = false
            if outcome.ok, let number = outcome.number {
                // A warning or the existing pull request is said before it opens; a clean create opens at once.
                if let notice = outcome.notice { done = (number, notice) } else { opened(number); dismiss() }
            } else { message = outcome.message }
        }
    }
}

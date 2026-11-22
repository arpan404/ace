import SwiftUI

/// Task: what the bot is for, in the person's words; it opens to edit. A bot from a package
/// says which one above it (`SpadeProfilePackage`), and its earlier versions fold under it. A
/// packaged bot's declared effects follow as its Security section.
struct SpadeProfileTask<Editor: View>: View {
    let task: String
    @ViewBuilder let edit: (String) -> Editor
    @Environment(\.spadeProfileScope) private var scope
    @State private var package: SpadePackageLine?

    var body: some View {
        Section("Task") {
            if let scope, let package {
                SpadeProfilePackage(scope: scope, line: package, changed: readPackage)
            }
            NavigationLink { edit(task) } label: {
                Text(task.isEmpty ? "What this bot is for, in your words" : task)
                    .aceFont(AceDesign.TextRole.message)
                    .foregroundStyle(task.isEmpty ? AceDesign.Ink.subtle : AceDesign.Ink.primary)
                    .lineLimit(8)
            }
            .accessibilityIdentifier("spade.profile.task")
            if let scope { SpadeTaskHistory(scope: scope, task: task) }
        }
        .task(id: scope?.agent) { await readPackage() }
        if let scope, let effects = package?.effects, !effects.isEmpty {
            SpadeProfileEffects(scope: scope, effects: effects, changed: readPackage)
        }
    }

    /// The package line and its effects, read as the profile opens and after anything that
    /// changes them; a read that failed keeps what showed.
    private func readPackage() async {
        guard let scope else { return }
        let answer = await scope.client.spadePackage(scope.agent)
        if answer.ok { package = answer.package }
    }
}

/// The task on its own page: the bot's instructions in the person's words, saved with Save.
/// While the write is out the field and Save wait and the page stays (`SpadeTaskSave`); once it
/// went they stay locked until the page closes on the reloaded profile.
struct SpadeTaskEditor: View {
    let client: ClientModel
    let agent: String
    let task: String
    /// The task as Spade stored it.
    let saved: (String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var save = SpadeTaskSave()
    @State private var problem: String?
    @FocusState private var focused: Bool

    private var changed: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines) != task.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Form {
            Section {
                TextEditor(text: $text)
                    .aceFont(AceDesign.TextRole.message)
                    .frame(minHeight: AceDesign.Size.rowThread * 3)
                    .focused($focused)
                    .disabled(save.locked)
                    .accessibilityIdentifier("spade.task.field")
            } footer: {
                if let problem {
                    Text(problem).foregroundStyle(AceTheme.StatusText.failed)
                } else {
                    Text("What this bot is for, in your words.")
                }
            }
        }
        .navigationTitle("Task")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(save.locked)
        .interactiveDismissDisabled(save.locked)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                if save.locked { ProgressView() } else {
                    Button("Save") { submit() }
                        .disabled(!changed)
                        .accessibilityIdentifier("spade.task.save")
                }
            }
        }
        .onAppear {
            text = task
            focused = true
        }
    }

    private func submit() {
        guard let words = save.begin(text, task: task) else { return }
        problem = nil
        focused = false
        Task {
            let outcome = await client.spadeTask(agent, task: words)
            guard outcome.ok else {
                save.refused()
                problem = outcome.problem
                return
            }
            await saved(outcome.task ?? words)
            dismiss()
        }
    }
}

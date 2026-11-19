import SwiftUI

struct TaskProfilesView: View {
    let store: TaskProfileStore
    @State private var profiles: [TaskProfile] = []
    @State private var problem: String?
    var body: some View {
        List {
            if let problem { Section { ProblemRow("Couldn't remove the profile.", detail: problem, id: "profiles.problem") } }
            if !profiles.isEmpty {
                Section {
                    ForEach(profiles) { profile in
                        NavigationLink { TaskProfileEditor(store: store, profile: profile, isNew: false) } label: { InsetRow(profile.name, systemImage: nil) }
                    }.onDelete { indices in
                        do { for index in indices { try store.remove(profiles[index].id) }; profiles = store.load() }
                        catch { problem = error.localizedDescription }
                    }
                }
                .insetRowBackground()
            }
            Section {
                NavigationLink { TaskProfileEditor(store: store, profile: TaskProfile(id: UUID().uuidString, name: "", instructions: ""), isNew: true) } label: {
                    AddRow("New profile")
                }
            } footer: {
                if profiles.isEmpty { Text("A profile is instructions you can start new tasks with.") }
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Task profiles").navigationBarTitleDisplayMode(.inline)
        .onAppear { profiles = store.load() }
    }
}
private struct TaskProfileEditor: View {
    let store: TaskProfileStore
    @State var profile: TaskProfile
    let isNew: Bool
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            if let problem { Section { ProblemRow("Couldn't save the profile.", detail: problem, id: "profile.problem") } }
            Section { TextField("Profile name", text: $profile.name) }.insetRowBackground()
            Section {
                TextEditor(text: $profile.instructions).frame(minHeight: AceDesign.Size.tap * 5)
                    .scrollContentBackground(.hidden).accessibilityLabel("Profile instructions")
            } header: { InsetHeader("Instructions") } footer: {
                Text("Added to the first message of new tasks that use this profile. Tasks already started keep theirs.")
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle(isNew ? "New profile" : "Edit profile").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    do { try store.save(profile); dismiss() } catch { problem = error.localizedDescription }
                }
                .disabled(profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("profile.save")
            }
        }
    }
}

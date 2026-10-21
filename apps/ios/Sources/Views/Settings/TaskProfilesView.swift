import SwiftUI

struct TaskProfilesView: View {
    let store: TaskProfileStore
    @State private var profiles: [TaskProfile] = []
    @State private var problem: String?
    var body: some View {
        List {
            ServiceProblem(message: problem)
            if !profiles.isEmpty {
                Section {
                    ForEach(profiles) { profile in
                        NavigationLink { TaskProfileEditor(store: store, profile: profile) } label: { InsetRow(profile.name, systemImage: "person.text.rectangle") }
                    }.onDelete { indices in
                        do { for index in indices { try store.remove(profiles[index].id) }; profiles = store.load() }
                        catch { problem = error.localizedDescription }
                    }
                }
                .insetRowBackground()
            }
            Section {
                NavigationLink { TaskProfileEditor(store: store, profile: TaskProfile(id: UUID().uuidString, name: "", instructions: "")) } label: {
                    InsetRow("New profile", systemImage: "plus")
                }
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
    @State private var problem: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        Form {
            Section { TextField("Profile name", text: $profile.name) }.insetRowBackground()
            Section {
                TextEditor(text: $profile.instructions).frame(minHeight: AceTheme.Dimensions.touchTarget * 5)
                    .scrollContentBackground(.hidden).accessibilityLabel("Profile instructions")
            } header: { InsetHeader("Instructions") } footer: {
                Text("Included in the first message of new tasks that use this profile. Existing conversations keep their original instructions.")
            }
            .insetRowBackground()
            ServiceProblem(message: problem)
            Section {
                Button("Save profile") {
                    do { try store.save(profile); dismiss() } catch { problem = error.localizedDescription }
                }
                .foregroundStyle(AceTheme.Colours.foreground)
                .disabled(profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .insetRowBackground()
        }
        .insetGroupedList()
        .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
    }
}

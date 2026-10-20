import SwiftUI

struct TaskProfilesView: View {
    let store: TaskProfileStore
    @State private var profiles: [TaskProfile] = []
    @State private var problem: String?
    var body: some View {
        List {
            ServiceProblem(message: problem)
            ForEach(profiles) { profile in
                NavigationLink(profile.name) { TaskProfileEditor(store: store, profile: profile) }
            }.onDelete { indices in
                do { for index in indices { try store.remove(profiles[index].id) }; profiles = store.load() }
                catch { problem = error.localizedDescription }
            }
            NavigationLink("New profile") { TaskProfileEditor(store: store, profile: TaskProfile(id: UUID().uuidString, name: "", instructions: "")) }
        }
        .navigationTitle("Profiles").navigationBarTitleDisplayMode(.inline)
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
            TextField("Profile name", text: $profile.name)
            Section {
                TextEditor(text: $profile.instructions).frame(minHeight: AceTheme.Dimensions.touchTarget * 5).accessibilityLabel("Profile instructions")
            } footer: { Text("Included in the first message of new tasks that use this profile. Existing conversations keep their original instructions.") }
            ServiceProblem(message: problem)
            Button("Save profile") {
                do { try store.save(profile); dismiss() } catch { problem = error.localizedDescription }
            }.disabled(profile.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }.navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
    }
}

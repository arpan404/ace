import SwiftUI

struct AceAccountView: View {
    @State private var model = AceAccountModel()
    @Environment(\.openURL) private var openURL

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.largeTitle)
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.account.map { $0.name.isEmpty ? $0.email : $0.name } ?? "Your profile")
                            .fontWeight(.medium)
                        Text(model.account?.email ?? (model.login == nil ? "Not signed in" : "Complete sign-in in your browser"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.account != nil {
                        Button("Sign out") { Task { await model.signOut() } }
                            .disabled(model.busy)
                    } else if model.login != nil {
                        Button("Cancel") { model.cancel() }
                    } else {
                        Button("Sign in") { model.signIn() }
                            .disabled(!model.configured || model.busy)
                    }
                }
            }
            if let error = model.error { Section { ServiceProblem(message: error) } }
        }
        .navigationTitle("Profile")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.restore() }
        .onChange(of: model.login?.loginUrl) { _, url in if let url { openURL(url) } }
        .onDisappear { model.cancel() }
    }
}

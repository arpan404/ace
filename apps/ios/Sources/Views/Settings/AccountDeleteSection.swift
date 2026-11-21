import SwiftUI

/// Profile's Delete account row (App Store guideline 5.1.1(v)), with the question that says what
/// goes and what stays. A failure shows as the page's account problem; `deleted` runs once the
/// account is gone, so the page can say so after this section leaves it.
struct AccountDeleteSection: View {
    let model: AceAccountModel
    let deleted: () -> Void
    @State private var asking = false

    var body: some View {
        Section {
            Button("Delete account", role: .destructive) { asking = true }
                .frame(maxWidth: .infinity)
                .disabled(model.busy)
                .accessibilityIdentifier("account.delete")
                .confirmationDialog("Delete your ace account?", isPresented: $asking, titleVisibility: .visible) {
                    Button("Delete account", role: .destructive) {
                        Task { if await model.deleteAccount() { deleted() } }
                    }
                        .accessibilityIdentifier("account.delete.confirm")
                } message: {
                    Text("This deletes your ace account, its sessions and its list of machines on every device. Your machines, and their threads and code, stay on your computers. This can't be undone.")
                }
        }
        .insetRowBackground()
    }
}

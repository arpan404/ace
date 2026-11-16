import UIKit

/// What a keyboard notification says about the move it announces: where the keyboard ends up, in
/// screen points, and how long it takes. The composer (`FloatingBar`) and the transcript
/// (`ConversationFeed`) each read the same notification, so both start in the same update.
struct KeyboardMove {
    let end: CGRect
    let duration: Double

    init?(_ note: Notification) {
        guard let end = note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return nil }
        self.end = end
        duration = note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
    }
}

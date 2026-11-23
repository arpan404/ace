/// What the files on the next message mean for Send: it waits while any is uploading or failed
/// (the bridge refuses such a message, `thread-attachments.ts`).
enum AttachmentUploads {
    /// Whether Send waits for the files.
    static func holdsSend(_ files: [AttachmentFile]) -> Bool { line(files) != nil }

    /// The accessible Send label while files are blocking it.
    static func line(_ files: [AttachmentFile]) -> String? {
        let failed = files.filter { $0.state == "failed" }.count
        if failed > 0 {
            return failed == 1 ? "1 file didn't upload. Retry or remove it to send."
                : "\(failed) files didn't upload. Retry or remove them to send."
        }
        return files.contains { $0.state == "uploading" } ? "Files uploading" : nil
    }
}

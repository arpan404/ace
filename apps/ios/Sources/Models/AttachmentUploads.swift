/// What the files on the next message mean for Send: it waits while any is uploading or failed
/// (the bridge refuses such a message, `thread-attachments.ts`), and the composer says why.
enum AttachmentUploads {
    /// Whether Send waits for the files.
    static func holdsSend(_ files: [AttachmentFile]) -> Bool { line(files) != nil }

    /// The line under the files while Send waits; nil once every file is on.
    static func line(_ files: [AttachmentFile]) -> String? {
        let failed = files.filter { $0.state == "failed" }.count
        if failed > 0 {
            return failed == 1 ? "1 file didn't upload. Retry or remove it to send."
                : "\(failed) files didn't upload. Retry or remove them to send."
        }
        let uploading = files.filter { $0.state == "uploading" }.count
        if uploading > 0 {
            return uploading == 1 ? "Uploading 1 file. Send waits until it's done."
                : "Uploading \(uploading) files. Send waits until they're done."
        }
        return nil
    }
}

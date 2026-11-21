import Foundation

struct BridgeFragment: Decodable, Sendable {
    let id: String
    let index: Int
    let last: Bool
    let data: String
}

/// One acknowledged transfer at a time; fragments never expose a partially updated row.
struct BridgeFrames {
    private var transferId: String?
    private var nextIndex = 0
    private var assembly = Data()
    /// A transfer has begun and its last fragment is still to come.
    var assembling: Bool { transferId != nil }

    mutating func decode(_ data: Data) throws -> [BridgePatch] {
        do {
            guard data.count <= 32768 else { throw FrameError.budget }
            let patches = try JSONDecoder().decode([BridgePatch].self, from: data)
            guard patches.count <= 32 else { throw FrameError.budget }
            var result: [BridgePatch] = []
            for patch in patches {
                if case .fragment(let fragment) = patch {
                    if transferId == nil {
                        guard fragment.index == 0 else { throw FrameError.order }
                        transferId = fragment.id
                    }
                    // SDK reassembly admits 64 MiB UTF-16, independently of its 2 MiB
                    // physical frames. Allow UTF-8 expansion, duplicated DTO identities
                    // and a separately retained scope ID. No capacity is preallocated.
                    guard transferId == fragment.id, nextIndex == fragment.index,
                          fragment.data.utf8.count <= 24576,
                          let bytes = Data(base64Encoded: fragment.data), bytes.count <= 18432,
                          assembly.count + bytes.count <= 512 * 1024 * 1024 else { throw FrameError.budget }
                    assembly.append(bytes)
                    nextIndex += 1
                    if fragment.last {
                        let assembled = try JSONDecoder().decode(BridgePatch.self, from: assembly)
                        if case .fragment = assembled { throw FrameError.order }
                        result.append(assembled)
                        reset()
                    }
                } else {
                    guard transferId == nil else { throw FrameError.order }
                    result.append(patch)
                }
            }
            return result
        } catch { reset(); throw error }
    }
    private mutating func reset() { transferId = nil; nextIndex = 0; assembly = Data() }
}
private enum FrameError: Error { case budget, order }

/// Decodes a runtime's frames on a queue of its own, so neither the main thread nor the script's
/// thread waits on JSON. One frame is in flight at a time (the bridge waits for its acknowledgment),
/// and the serial queue keeps fragment assembly in order.
final class FrameDecoder: @unchecked Sendable {
    private let queue = DispatchQueue(label: "ace.client.frames", qos: .userInitiated)
    private var frames = BridgeFrames()
    /// Bytes of the fragments taken since the last frame that ended no transfer.
    private var carried = 0
    /// Decodes `data`, then hands `done` the frame's complete patches, or nil when it could not be
    /// read (the assembly resets), with the bytes they weigh. A frame that ends a transfer weighs
    /// every fragment of it, so a patch sent in pieces counts whole toward the early-ack cap
    /// (`FrameIntake.answeredLimit`).
    func decode(_ data: Data, then done: @escaping @Sendable ([BridgePatch]?, Int) -> Void) {
        queue.async { [self] in
            let patches = HostTrace.measure("host.decodeFrame", bytes: data.count) { try? frames.decode(data) }
            carried += data.count
            let bytes = frames.assembling ? data.count : carried
            if !frames.assembling { carried = 0 }
            done(patches, bytes)
        }
    }
}

import Foundation
import Darwin

/// One framed, full-duplex stream over a connected socket descriptor. Reads arrive on
/// `queue`; an oversized or empty frame, EOF or read error closes the descriptor and
/// calls `onClose` exactly once. Writes are serialized on the same queue.
public final class LockedUseFramedConnection: @unchecked Sendable {
    private let fd: Int32
    private let queue: DispatchQueue
    private let onFrame: (Data) -> Void
    private let onClose: () -> Void
    private var decoder = LockedUseFrameDecoder()
    private var source: DispatchSourceRead?
    private var closed = false

    public init(fd: Int32, queue: DispatchQueue, onFrame: @escaping (Data) -> Void, onClose: @escaping () -> Void) {
        self.fd = fd
        self.queue = queue
        self.onFrame = onFrame
        self.onClose = onClose
        var noSigPipe: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    }

    public func start() {
        queue.async { [self] in
            let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
            source.setEventHandler { [weak self] in self?.readAvailable() }
            source.setCancelHandler { [fd] in Darwin.close(fd) }
            self.source = source
            source.resume()
        }
    }

    public func send(_ payload: Data) {
        queue.async { [self] in
            guard !closed, let frame = try? lockedUseEncodeFrame(payload) else { return }
            var offset = 0
            while offset < frame.count {
                let written = frame.withUnsafeBytes { write(fd, $0.baseAddress! + offset, frame.count - offset) }
                if written < 0, errno == EINTR { continue }
                if written < 0, errno == EAGAIN { usleep(1000); continue }
                guard written > 0 else { close(); return }
                offset += written
            }
        }
    }

    public func close() {
        dispatchPrecondition(condition: .onQueue(queue))
        guard !closed else { return }
        closed = true
        if let source { source.cancel() } else { Darwin.close(fd) }
        onClose()
    }

    public func closeAsync() { queue.async { [self] in close() } }

    private func readAvailable() {
        var buffer = [UInt8](repeating: 0, count: 16_384)
        let count = read(fd, &buffer, buffer.count)
        if count < 0, errno == EINTR || errno == EAGAIN { return }
        guard count > 0 else { close(); return }
        do {
            for frame in try decoder.append(Data(buffer.prefix(count))) {
                guard !closed else { return }
                onFrame(frame)
            }
        } catch { close() }
    }
}

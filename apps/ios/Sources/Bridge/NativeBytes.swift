import Foundation
import JavaScriptCore
import zlib

/// Byte work the bridge hands to native code. JavaScriptCore runs without a JIT in an app, and
/// bytes crossing as arrays of numbers cost ~340 ms per MiB; a `Uint8Array` crosses by pointer.
/// Every function runs on the runtime's JavaScript thread and uses the pointer only while it runs.
enum NativeBytes {
    /// The most any one input may expand to. Callers apply their own, smaller limits after.
    static let inflateCeiling = 16 * 1024 * 1024

    /// `decode(bytes, encoding, fatal)`, `encode(text)` and `inflate(bytes, format)` for `aceHost`.
    static func functions() -> [String: Any] {
        let decode: @convention(block) (JSValue, String, Bool) -> String = { value, encoding, fatal in HostTrace.measure("host.decode") {
            let selected: String.Encoding = encoding.lowercased() == "utf-16le" ? .utf16LittleEndian : .utf8
            let text = withBytes(of: value) { bytes -> String? in
                if let text = String(bytes: bytes, encoding: selected) { return text }
                return fatal ? nil : String(decoding: bytes, as: UTF8.self)
            }
            guard let text = text ?? nil else {
                JSContext.current()?.exception = JSValue(newErrorFromMessage: "Invalid encoded text", in: JSContext.current())
                return ""
            }
            return text
        } }
        let encode: @convention(block) (String) -> JSValue = { text in
            guard let context = JSContext.current() else { return JSValue() }
            var text = text
            return HostTrace.measure("host.encode") { text.withUTF8 { makeArray(UnsafeRawBufferPointer($0), in: context) } }
        }
        let inflate: @convention(block) (JSValue, String) -> JSValue = { value, format in
            guard let context = JSContext.current() else { return JSValue() }
            guard let bits = windowBits(format),
                  let output = HostTrace.measure("host.inflate", { withBytes(of: value, { expand($0, windowBits: bits, limit: inflateCeiling) }) }) ?? nil else {
                return JSValue(nullIn: context)
            }
            return output.withUnsafeBytes { makeArray($0, in: context) }
        }
        return ["decode": decode, "encode": encode, "inflate": inflate]
    }

    /// The bytes a `Uint8Array` views, or nil for anything else.
    static func withBytes<T>(of value: JSValue, _ body: (UnsafeRawBufferPointer) -> T) -> T? {
        guard let context = value.context?.jsGlobalContextRef,
              JSValueGetTypedArrayType(context, value.jsValueRef, nil) == kJSTypedArrayTypeUint8Array,
              let object = JSValueToObject(context, value.jsValueRef, nil) else { return nil }
        let count = JSObjectGetTypedArrayByteLength(context, object, nil)
        // The pointer is the buffer's start; the view begins at its byte offset.
        guard count > 0, let base = JSObjectGetTypedArrayBytesPtr(context, object, nil) else {
            return body(UnsafeRawBufferPointer(start: nil, count: 0))
        }
        let offset = JSObjectGetTypedArrayByteOffset(context, object, nil)
        return body(UnsafeRawBufferPointer(start: base + offset, count: count))
    }

    /// A new `Uint8Array` holding a copy of `bytes`.
    static func makeArray(_ bytes: UnsafeRawBufferPointer, in context: JSContext) -> JSValue {
        let reference = context.jsGlobalContextRef
        guard let object = JSObjectMakeTypedArray(reference, kJSTypedArrayTypeUint8Array, bytes.count, nil) else {
            return JSValue(nullIn: context)
        }
        if bytes.count > 0, let source = bytes.baseAddress, let target = JSObjectGetTypedArrayBytesPtr(reference, object, nil) {
            target.copyMemory(from: source, byteCount: bytes.count)
        }
        return JSValue(jsValueRef: object, in: context)
    }

    /// zlib's window bits for a `DecompressionStream` format name.
    static func windowBits(_ format: String) -> Int32? {
        switch format {
        case "gzip": 15 + 16
        case "deflate": 15
        case "deflate-raw": -15
        default: nil
        }
    }

    /// One whole compressed input expanded, or nil when it is corrupt, truncated, followed by
    /// stray bytes, or would expand past `limit`. Gzip's CRC and length are checked by zlib.
    static func expand(_ input: UnsafeRawBufferPointer, windowBits: Int32, limit: Int) -> Data? {
        var stream = z_stream()
        guard inflateInit2_(&stream, windowBits, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else { return nil }
        defer { inflateEnd(&stream) }
        guard let start = input.baseAddress?.assumingMemoryBound(to: Bytef.self) else { return nil }
        stream.next_in = UnsafeMutablePointer(mutating: start)
        stream.avail_in = uInt(input.count)
        var output = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let status = chunk.withUnsafeMutableBufferPointer { buffer -> Int32 in
                stream.next_out = buffer.baseAddress
                stream.avail_out = uInt(buffer.count)
                return zlib.inflate(&stream, Z_NO_FLUSH)
            }
            let produced = chunk.count - Int(stream.avail_out)
            guard output.count + produced <= limit else { return nil }
            output.append(contentsOf: chunk[0..<produced])
            switch status {
            case Z_STREAM_END: return stream.avail_in == 0 ? output : nil
            case Z_OK: continue
            // Z_BUF_ERROR with input left means no progress was possible: the input ended early.
            default: return nil
            }
        }
    }
}

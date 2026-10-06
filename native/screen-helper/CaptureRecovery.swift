import Foundation
import ScreenCaptureKit

/// Only system interruptions may restart an approved capture. Cancellation never does.
func recoverableCaptureError(_ error: NSError) -> Bool {
    guard error.domain == SCStreamError.errorDomain else { return false }
    if error.code == SCStreamError.failedApplicationConnectionInterrupted.rawValue || error.code == SCStreamError.internalError.rawValue { return true }
    if #available(macOS 15.0, *), error.code == SCStreamError.systemStoppedStream.rawValue { return true }
    return false
}

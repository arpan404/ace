import Foundation
import Darwin

func resourceMetrics() -> [String: Any] {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let seconds = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec)
    let micros = Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec)
    return ["cpuMicros": seconds * 1_000_000 + micros, "peakRssBytes": usage.ru_maxrss]
}

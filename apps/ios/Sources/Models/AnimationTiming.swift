import Foundation

/// How far through its change a Core Animation timing is at a given moment, as 0 at the start and
/// 1 at the end, for the two kinds the system's keyboard animations use: a cubic Bézier timing
/// curve and a spring. Used to read where the keyboard is drawn on the frame about to be shown
/// (`KeyboardEdgeTracker`, #2170).
enum AnimationTiming {
    /// A Bézier timing curve from (0, 0) to (1, 1) through control points (`x1`, `y1`) and
    /// (`x2`, `y2`), at time fraction `t`.
    static func bezier(x1: Double, y1: Double, x2: Double, y2: Double, at t: Double) -> Double {
        let t = min(max(t, 0), 1)
        // Find the curve's parameter whose x is `t`, then read its y.
        var low = 0.0, high = 1.0, u = t
        for _ in 0..<40 {
            let x = cubic(x1, x2, u)
            if abs(x - t) < 1e-7 { break }
            if x < t { low = u } else { high = u }
            u = (low + high) / 2
        }
        return cubic(y1, y2, u)
    }

    /// A spring of `mass`, `stiffness` and `damping` released toward its target with
    /// `initialVelocity` (in distances per second, toward the target), `elapsed` seconds in.
    static func spring(mass: Double, stiffness: Double, damping: Double, initialVelocity: Double, elapsed: Double) -> Double {
        guard elapsed > 0 else { return 0 }
        guard mass > 0, stiffness > 0 else { return 1 }
        let omega = (stiffness / mass).squareRoot()
        let zeta = damping / (2 * (stiffness * mass).squareRoot())
        // Displacement from the target, 1 at the start, moving at -initialVelocity.
        let x0 = 1.0, v0 = -initialVelocity
        let x: Double
        if zeta < 1 {
            let omegaD = omega * (1 - zeta * zeta).squareRoot()
            let b = (v0 + zeta * omega * x0) / omegaD
            x = exp(-zeta * omega * elapsed) * (x0 * cos(omegaD * elapsed) + b * sin(omegaD * elapsed))
        } else if zeta == 1 {
            x = exp(-omega * elapsed) * (x0 + (v0 + omega * x0) * elapsed)
        } else {
            let root = (zeta * zeta - 1).squareRoot()
            let r1 = -omega * (zeta - root), r2 = -omega * (zeta + root)
            let c2 = (v0 - r1 * x0) / (r2 - r1)
            let c1 = x0 - c2
            x = c1 * exp(r1 * elapsed) + c2 * exp(r2 * elapsed)
        }
        return 1 - x
    }

    /// One coordinate of a Bézier from 0 to 1 with inner control values `a` and `b`, at `u`.
    private static func cubic(_ a: Double, _ b: Double, _ u: Double) -> Double {
        let v = 1 - u
        return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
    }
}

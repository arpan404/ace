import UIKit

// Owned, disposable app: pixel clock updated at display cadence and a tap acknowledgement.
final class ProbeView: UIView {
    var tapped = false
    override init(frame: CGRect) {
        super.init(frame: frame)
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.add(to: .main, forMode: .common)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap)))
    }
    required init?(coder: NSCoder) { fatalError() }
    @objc func tick() { setNeedsDisplay() }
    @objc func tap() { tapped.toggle(); setNeedsDisplay() }
    override func draw(_ rect: CGRect) {
        UIColor.darkGray.setFill(); UIRectFill(rect)
        let time = UInt64(Date().timeIntervalSince1970 * 1000) & 0xffffffff
        let cell = bounds.width / 40
        let y = bounds.height / 2
        UIColor.red.setFill(); UIRectFill(CGRect(x: cell * 3, y: y, width: cell, height: cell * 3))
        for bit in 0..<32 {
            ((time >> bit) & 1 == 1 ? UIColor.white : UIColor.black).setFill()
            UIRectFill(CGRect(x: cell * CGFloat(bit + 4), y: y, width: cell, height: cell * 3))
        }
        (tapped ? UIColor.green : UIColor.blue).setFill()
        UIRectFill(CGRect(x: cell * 36, y: y, width: cell, height: cell * 3))
        let x = CGFloat(time % 2000) / 2000 * bounds.width
        UIColor.orange.setFill(); UIRectFill(CGRect(x: x, y: bounds.height / 3, width: 30, height: 30))
    }
}
@main final class App: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        let controller = UIViewController(); controller.view = ProbeView(frame: window.bounds)
        window.rootViewController = controller; window.makeKeyAndVisible(); self.window = window
        return true
    }
}

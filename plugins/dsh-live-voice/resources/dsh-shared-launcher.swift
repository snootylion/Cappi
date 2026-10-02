import AppKit
import CoreGraphics
import Foundation
import Network
import WebKit

private let harnessURL = URL(string: "http://127.0.0.1:3083")!
private let voicePanelPort: NWEndpoint.Port = 43129
private let allowedWebOrigin = "http://127.0.0.1:3083"

private struct VoicePanelState: Decodable {
  let phase: String
  let active: Bool
  let muted: Bool
  let working: Bool?
  let message: String?
  let clientId: String?
  let leaseId: String?
}

private final class VoiceOrbView: NSView {
  var phase = "idle" { didSet { needsDisplay = true } }
  private var pulse: CGFloat = 0
  private var pulseDirection: CGFloat = 1
  private var timer: Timer?

  override var isOpaque: Bool { false }

  func setAnimated(_ animated: Bool) {
    timer?.invalidate()
    timer = nil
    pulse = 0
    guard animated else { needsDisplay = true; return }
    timer = Timer.scheduledTimer(withTimeInterval: 0.055, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.pulse += 0.045 * self.pulseDirection
      if self.pulse >= 1 { self.pulse = 1; self.pulseDirection = -1 }
      if self.pulse <= 0 { self.pulse = 0; self.pulseDirection = 1 }
      self.needsDisplay = true
    }
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let inset: CGFloat = phase == "speaking" ? 4 - pulse * 2 : 4
    let haloRect = bounds.insetBy(dx: inset, dy: inset)
    let haloColor: NSColor
    switch phase {
    case "thinking": haloColor = NSColor.systemBlue.withAlphaComponent(0.28 + pulse * 0.12)
    case "hearing", "listening": haloColor = NSColor.systemGreen.withAlphaComponent(0.18 + pulse * 0.13)
    case "error": haloColor = NSColor.systemRed.withAlphaComponent(0.32)
    default: haloColor = NSColor.white.withAlphaComponent(0.12 + pulse * 0.08)
    }
    haloColor.setFill()
    NSBezierPath(ovalIn: haloRect).fill()

    let coreRect = bounds.insetBy(dx: 10, dy: 10)
    let colors = [
      NSColor(calibratedWhite: 0.98, alpha: 1).cgColor,
      NSColor(calibratedWhite: 0.68, alpha: 1).cgColor,
      NSColor(calibratedWhite: 0.25, alpha: 1).cgColor,
    ] as CFArray
    if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.46, 1]),
       let context = NSGraphicsContext.current?.cgContext {
      context.saveGState()
      context.addEllipse(in: coreRect)
      context.clip()
      context.drawRadialGradient(
        gradient,
        startCenter: CGPoint(x: coreRect.midX - 7, y: coreRect.midY + 8),
        startRadius: 1,
        endCenter: CGPoint(x: coreRect.midX, y: coreRect.midY),
        endRadius: coreRect.width * 0.58,
        options: [.drawsAfterEndLocation]
      )
      context.restoreGState()
    }

    if phase == "speaking" {
      NSColor.white.withAlphaComponent(0.76).setFill()
      let widths: [CGFloat] = [2, 2, 2, 2, 2]
      let heights: [CGFloat] = [7, 13, 18, 11, 6]
      for index in 0..<5 {
        let height = heights[index] * (0.72 + pulse * 0.28)
        let rect = NSRect(x: coreRect.midX - 11 + CGFloat(index) * 5, y: coreRect.midY - height / 2, width: widths[index], height: height)
        NSBezierPath(roundedRect: rect, xRadius: 1, yRadius: 1).fill()
      }
    }
  }
}

private final class VoicePanelController: NSObject {
  private let panel: NSPanel
  private let orb = VoiceOrbView(frame: NSRect(x: 24, y: 54, width: 56, height: 56))
  private let muteButton = NSButton(frame: NSRect(x: 17, y: 12, width: 30, height: 30))
  private let endButton = NSButton(frame: NSRect(x: 57, y: 12, width: 30, height: 30))
  private var state = VoicePanelState(phase: "idle", active: false, muted: false, working: false, message: nil, clientId: nil, leaseId: nil)
  private let positionKey = "KokoroVoicePanelPosition"

  override init() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 104, height: 122),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    super.init()
    configurePanel()
  }

  private func configurePanel() {
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.isMovableByWindowBackground = true
    panel.becomesKeyOnlyIfNeeded = true

    let surface = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 104, height: 122))
    surface.material = .hudWindow
    surface.blendingMode = .behindWindow
    surface.state = .active
    surface.wantsLayer = true
    surface.layer?.cornerRadius = 22
    surface.layer?.borderWidth = 1
    surface.layer?.borderColor = NSColor.white.withAlphaComponent(0.12).cgColor
    surface.layer?.masksToBounds = true
    panel.contentView = surface

    orb.wantsLayer = true
    orb.toolTip = "Live Voice"
    surface.addSubview(orb)

    configureButton(muteButton, symbol: "mic.fill", accessibilityLabel: "Mute microphone")
    muteButton.target = self
    muteButton.action = #selector(toggleMute)
    surface.addSubview(muteButton)

    configureButton(endButton, symbol: "stop.fill", accessibilityLabel: "End live voice")
    endButton.contentTintColor = .systemRed
    endButton.target = self
    endButton.action = #selector(endVoice)
    surface.addSubview(endButton)

    restorePosition()
    NotificationCenter.default.addObserver(self, selector: #selector(savePosition), name: NSWindow.didMoveNotification, object: panel)
  }

  private func configureButton(_ button: NSButton, symbol: String, accessibilityLabel: String) {
    button.bezelStyle = .texturedRounded
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 10
    button.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.09).cgColor
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: accessibilityLabel)
    button.imageScaling = .scaleProportionallyDown
    button.contentTintColor = NSColor.white.withAlphaComponent(0.88)
    button.toolTip = accessibilityLabel
    button.setAccessibilityLabel(accessibilityLabel)
  }

  func apply(_ nextState: VoicePanelState) {
    state = nextState
    guard nextState.active else {
      panel.orderOut(nil)
      orb.setAnimated(false)
      return
    }

    orb.phase = nextState.phase
    orb.toolTip = nextState.message ?? statusLabel(for: nextState.phase)
    orb.setAnimated(["listening", "hearing", "speaking", "thinking"].contains(nextState.phase))
    let muteSymbol = nextState.muted ? "mic.slash.fill" : "mic.fill"
    let muteLabel = nextState.muted ? "Unmute microphone" : "Mute microphone"
    muteButton.image = NSImage(systemSymbolName: muteSymbol, accessibilityDescription: muteLabel)
    muteButton.toolTip = muteLabel
    muteButton.setAccessibilityLabel(muteLabel)
    muteButton.setAccessibilityValue(nextState.muted ? "Muted" : "Unmuted")
    panel.orderFrontRegardless()
  }

  @objc private func toggleMute() {
    sendCommand("mute", muted: !state.muted)
  }

  @objc private func endVoice() {
    panel.orderOut(nil)
    sendCommand("stop", muted: nil)
  }

  private func sendCommand(_ command: String, muted: Bool?) {
    guard let clientId = state.clientId, let leaseId = state.leaseId else { return }
    var payload: [String: Any] = ["command": command, "clientId": clientId, "leaseId": leaseId]
    if let muted { payload["muted"] = muted }
    guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
    var request = URLRequest(url: harnessURL.appendingPathComponent("dsh-kokoro-live-voice/command"))
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    URLSession.shared.dataTask(with: request).resume()
  }

  private func statusLabel(for phase: String) -> String {
    switch phase {
    case "starting": return "Starting Live Voice"
    case "listening": return "Listening"
    case "hearing": return "Hearing you"
    case "thinking": return "Working"
    case "speaking": return "Speaking"
    case "muted": return "Microphone muted"
    case "error": return "Live Voice error"
    default: return "Live Voice"
    }
  }

  private func restorePosition() {
    if let saved = UserDefaults.standard.string(forKey: positionKey) {
      let point = NSPointFromString(saved)
      if NSScreen.screens.contains(where: { $0.visibleFrame.insetBy(dx: -80, dy: -80).contains(point) }) {
        panel.setFrameOrigin(point)
        return
      }
    }
    guard let frame = NSScreen.main?.visibleFrame else { return }
    panel.setFrameOrigin(NSPoint(x: frame.maxX - 132, y: frame.minY + 28))
  }

  @objc private func savePosition() {
    UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: positionKey)
  }
}

private final class LegacyPanelDragHandle: NSView {
  weak var panel: NSPanel?
  private var startMouse = NSPoint.zero
  private var startOrigin = NSPoint.zero

  override func mouseDown(with event: NSEvent) {
    startMouse = NSEvent.mouseLocation
    startOrigin = panel?.frame.origin ?? .zero
  }

  override func mouseDragged(with event: NSEvent) {
    let current = NSEvent.mouseLocation
    panel?.setFrameOrigin(NSPoint(
      x: startOrigin.x + current.x - startMouse.x,
      y: startOrigin.y + current.y - startMouse.y
    ))
  }
}

private final class LegacyVoicePanelController: NSObject, WKNavigationDelegate {
  private static let html = #"""
<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:dark;background:transparent}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}.voice-float{width:104px;height:122px;display:grid;justify-items:center;align-content:start;gap:8px;font-family:-apple-system,sans-serif}.orb{position:relative;width:72px;height:72px;display:grid;place-items:center}.core{position:relative;width:50px;height:50px;border-radius:50%;background:linear-gradient(150deg,#fafafa 0%,#e8e9eb 55%,#cfd2d6 100%);color:#272c34;display:flex;align-items:center;justify-content:center;gap:2.5px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.24);transition:box-shadow 180ms ease}.core span{width:2.5px;height:12px;border-radius:3px;background:currentColor;opacity:.82;transform-origin:center;animation:meter 850ms ease-in-out infinite alternate}.core span:nth-child(1),.core span:nth-child(5){height:7px;animation-delay:-420ms}.core span:nth-child(2),.core span:nth-child(4){height:17px;animation-delay:-220ms}.core span:nth-child(3){height:23px;animation-delay:-610ms}.controls{visibility:hidden;display:flex;gap:6px}.control{width:31px;height:31px}.voice-float[data-state=working] .core{background:radial-gradient(circle at 30% 24%,rgba(249,253,255,.96) 0%,rgba(202,229,251,.82) 26%,rgba(139,190,235,.22) 58%,transparent 76%),linear-gradient(145deg,#8ebde7 0%,#c9e3fa 48%,#78acda 100%);background-size:170% 170%,145% 145%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.38);animation:core-blue-roam 3.4s ease-in-out infinite alternate}.voice-float[data-state=working] .core span{animation-duration:1.45s}.voice-float[data-muted=true] .core span{animation:none;transform:scaleY(.32);opacity:.46}@keyframes core-blue-roam{0%{background-position:0% 5%,100% 95%;filter:saturate(.84) brightness(.96)}36%{background-position:82% 8%,22% 88%;filter:saturate(1.03) brightness(1.04)}68%{background-position:92% 88%,8% 18%;filter:saturate(.94) brightness(.99)}100%{background-position:5% 92%,88% 4%;filter:saturate(1.1) brightness(1.07)}}@keyframes meter{from{transform:scaleY(.55)}to{transform:scaleY(1.08)}}@media(prefers-reduced-motion:reduce){.core span,.voice-float[data-state=working] .core{animation:none!important}}
</style></head><body><section class="voice-float" data-state="listening" aria-label="Live voice session"><div class="orb" aria-hidden="true"><span class="core"><span></span><span></span><span></span><span></span><span></span></span></div><div class="controls"><button id="mute" class="control" type="button"></button><button class="control end" type="button"></button></div></section><script>
const root=document.querySelector('.voice-float');window.updateVoiceState=function(state){root.dataset.state=state.visualState;root.dataset.muted=String(state.muted);root.setAttribute('aria-label',state.status)};
</script></body></html>
"""#

  private let panel: NSPanel
  private let webView: WKWebView
  private let muteButton = NSButton(frame: NSRect(x: 17, y: 18, width: 31, height: 31))
  private let endButton = NSButton(frame: NSRect(x: 56, y: 18, width: 31, height: 31))
  private var state = VoicePanelState(phase: "idle", active: false, muted: false, working: false, message: nil, clientId: nil, leaseId: nil)
  private var webViewReady = false
  private let positionKey = "KokoroVoicePanelPosition"

  override init() {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: 104, height: 122),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 104, height: 122), configuration: configuration)
    super.init()
    configurePanel()
  }

  private func configurePanel() {
    panel.level = .floating
    panel.isFloatingPanel = true
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = false
    panel.becomesKeyOnlyIfNeeded = true

    let root = NSView(frame: NSRect(x: 0, y: 0, width: 104, height: 122))
    root.wantsLayer = true
    root.layer?.backgroundColor = NSColor.clear.cgColor
    panel.contentView = root

    webView.navigationDelegate = self
    webView.setValue(false, forKey: "drawsBackground")
    webView.isHidden = false
    root.addSubview(webView)
    webView.loadHTMLString(Self.html, baseURL: nil)

    let dragHandle = LegacyPanelDragHandle(frame: NSRect(x: 16, y: 50, width: 72, height: 72))
    dragHandle.panel = panel
    dragHandle.toolTip = "Drag Live Voice"
    root.addSubview(dragHandle)

    configureButton(muteButton, symbol: "mic.fill", accessibilityLabel: "Mute microphone")
    muteButton.target = self
    muteButton.action = #selector(toggleMute)
    root.addSubview(muteButton)

    configureButton(endButton, symbol: "stop.fill", accessibilityLabel: "End live voice")
    endButton.contentTintColor = NSColor.systemRed.withAlphaComponent(0.94)
    endButton.target = self
    endButton.action = #selector(endVoice)
    root.addSubview(endButton)

    restorePosition()
    NotificationCenter.default.addObserver(self, selector: #selector(savePosition), name: NSWindow.didMoveNotification, object: panel)
  }

  private func configureButton(_ button: NSButton, symbol: String, accessibilityLabel: String) {
    button.bezelStyle = .circular
    button.isBordered = false
    button.wantsLayer = true
    button.layer?.cornerRadius = 15.5
    button.layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.82).cgColor
    button.layer?.borderWidth = 1
    button.layer?.borderColor = NSColor.white.withAlphaComponent(0.15).cgColor
    button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: accessibilityLabel)
    button.imageScaling = .scaleProportionallyDown
    button.contentTintColor = NSColor.white.withAlphaComponent(0.88)
    button.toolTip = accessibilityLabel
    button.setAccessibilityLabel(accessibilityLabel)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webViewReady = true
    updateVisualState()
  }

  func apply(_ nextState: VoicePanelState) {
    state = nextState
    guard nextState.active else {
      panel.orderOut(nil)
      return
    }
    let muteSymbol = nextState.muted ? "mic.slash.fill" : "mic.fill"
    let muteLabel = nextState.muted ? "Unmute microphone" : "Mute microphone"
    muteButton.image = NSImage(systemSymbolName: muteSymbol, accessibilityDescription: muteLabel)
    muteButton.toolTip = muteLabel
    muteButton.setAccessibilityLabel(muteLabel)
    muteButton.setAccessibilityValue(nextState.muted ? "Muted" : "Unmuted")
    updateVisualState()
    panel.orderFrontRegardless()
  }

  private func updateVisualState() {
    guard webViewReady else { return }
    let visualState: String
    if state.working == true || state.phase == "thinking" {
      visualState = "working"
    } else if state.phase == "speaking" {
      visualState = "speaking"
    } else {
      visualState = "listening"
    }
    let payload: [String: Any] = [
      "visualState": visualState,
      "muted": state.muted,
      "status": state.message ?? statusLabel(for: state.phase),
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let json = String(data: data, encoding: .utf8) else { return }
    webView.evaluateJavaScript("window.updateVoiceState(\(json))")
  }

  @objc private func toggleMute() {
    sendCommand("mute", muted: !state.muted)
  }

  @objc private func endVoice() {
    panel.orderOut(nil)
    sendCommand("stop", muted: nil)
  }

  private func sendCommand(_ command: String, muted: Bool?) {
    guard let clientId = state.clientId, let leaseId = state.leaseId else { return }
    var payload: [String: Any] = ["command": command, "clientId": clientId, "leaseId": leaseId]
    if let muted { payload["muted"] = muted }
    guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
    var request = URLRequest(url: harnessURL.appendingPathComponent("dsh-kokoro-live-voice/command"))
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    URLSession.shared.dataTask(with: request).resume()
  }

  private func statusLabel(for phase: String) -> String {
    switch phase {
    case "starting": return "Starting Live Voice"
    case "listening": return "Listening"
    case "hearing": return "Hearing you"
    case "thinking": return "Working"
    case "speaking": return "Speaking"
    case "muted": return "Microphone muted"
    case "error": return "Live Voice error"
    default: return "Live Voice"
    }
  }

  private func restorePosition() {
    if let saved = UserDefaults.standard.string(forKey: positionKey) {
      let point = NSPointFromString(saved)
      if NSScreen.screens.contains(where: { $0.visibleFrame.insetBy(dx: -80, dy: -80).contains(point) }) {
        panel.setFrameOrigin(point)
        return
      }
    }
    guard let frame = NSScreen.main?.visibleFrame else { return }
    panel.setFrameOrigin(NSPoint(x: frame.maxX - 132, y: frame.minY + 28))
  }

  @objc private func savePosition() {
    UserDefaults.standard.set(NSStringFromPoint(panel.frame.origin), forKey: positionKey)
  }
}

private final class VoicePanelServer {
  private let queue = DispatchQueue(label: "ai.deepseek.harness.voice-panel")
  private let listener: NWListener
  private let onState: (VoicePanelState) -> Void

  init(onState: @escaping (VoicePanelState) -> Void) throws {
    listener = try NWListener(using: .tcp, on: voicePanelPort)
    self.onState = onState
  }

  func start() {
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
    listener.start(queue: queue)
  }

  func stop() {
    listener.cancel()
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(on: connection, data: Data())
  }

  private func receive(on connection: NWConnection, data: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] chunk, _, complete, error in
      guard let self else { connection.cancel(); return }
      var buffer = data
      if let chunk { buffer.append(chunk) }
      if self.hasCompleteRequest(buffer) || complete || error != nil {
        self.handle(buffer, on: connection)
      } else if buffer.count < 1_048_576 {
        self.receive(on: connection, data: buffer)
      } else {
        self.respond(status: "413 Payload Too Large", body: Data(), on: connection)
      }
    }
  }

  private func hasCompleteRequest(_ data: Data) -> Bool {
    guard let text = String(data: data, encoding: .utf8), let marker = text.range(of: "\r\n\r\n") else { return false }
    let headers = String(text[..<marker.lowerBound])
    let length = headers.split(separator: "\n").first(where: { $0.lowercased().hasPrefix("content-length:") })
      .flatMap { Int($0.split(separator: ":", maxSplits: 1).last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "") } ?? 0
    let headerBytes = text[..<marker.upperBound].utf8.count
    return data.count >= headerBytes + length
  }

  private func handle(_ data: Data, on connection: NWConnection) {
    guard let text = String(data: data, encoding: .utf8), let marker = text.range(of: "\r\n\r\n") else {
      respond(status: "400 Bad Request", body: Data(), on: connection)
      return
    }
    let headerText = String(text[..<marker.lowerBound])
    let firstLine = headerText.split(separator: "\n").first.map(String.init) ?? ""
    let parts = firstLine.split(separator: " ")
    guard parts.count >= 2 else { respond(status: "400 Bad Request", body: Data(), on: connection); return }
    let method = String(parts[0])
    let path = String(parts[1])

    if method == "OPTIONS" {
      respond(status: "204 No Content", body: Data(), on: connection)
      return
    }
    if method == "GET" && path == "/health" {
      let body = Data("{\"service\":\"dsh-live-voice-panel\"}".utf8)
      respond(status: "200 OK", body: body, on: connection)
      return
    }
    if method == "POST" && path == "/state" {
      let headerByteCount = text[..<marker.upperBound].utf8.count
      let body = data.dropFirst(headerByteCount)
      guard let state = try? JSONDecoder().decode(VoicePanelState.self, from: body) else {
        respond(status: "400 Bad Request", body: Data(), on: connection)
        return
      }
      DispatchQueue.main.async { [onState] in onState(state) }
      respond(status: "204 No Content", body: Data(), on: connection)
      return
    }
    respond(status: "404 Not Found", body: Data(), on: connection)
  }

  private func respond(status: String, body: Data, on connection: NWConnection) {
    let header = "HTTP/1.1 \(status)\r\nAccess-Control-Allow-Origin: \(allowedWebOrigin)\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Accept\r\nContent-Type: application/json\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
    var response = Data(header.utf8)
    response.append(body)
    connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
  }
}

final class HarnessAppDelegate: NSObject, NSApplicationDelegate {
  private let chromeBinary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  private let harnessOrigin = harnessURL.absoluteString
  private let launchAgentLabel = "ai.deepseek.dsh-tailscale-remote"
  private let supportDirectory = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/DeepSeek Harness Shared", isDirectory: true)
  private let serviceLog = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Logs/dsh-tailscale-remote/stdout.log")
  private let launchAgentPlist = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/LaunchAgents/ai.deepseek.dsh-tailscale-remote.plist")
  private var chromeApplication: NSRunningApplication?
  private var chromeEnded = false
  private var chromeLaunchInProgress = false
  private var chromeLifecycleStarted = false
  private var pendingChromeURL: String?
  private var authenticationAttempts = 0
  private var windowlessChecks = 0
  private var chromeWindowSeen = false
  private var isProbingService = false
  private var monitor: Timer?
  private var voicePanel: LegacyVoicePanelController?
  private var voicePanelServer: VoicePanelServer?

  private var pidFile: URL { supportDirectory.appendingPathComponent("chrome.pid") }
  private var urlFile: URL { supportDirectory.appendingPathComponent("chrome.url") }
  private var chromeProfile: URL { supportDirectory.appendingPathComponent("Chrome", isDirectory: true) }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    let panel = LegacyVoicePanelController()
    voicePanel = panel
    do {
      let server = try VoicePanelServer { [weak panel] state in panel?.apply(state) }
      server.start()
      voicePanelServer = server
    } catch {
      presentError("Could not start the floating Live Voice panel: \(error.localizedDescription)")
    }
    kickstartHarnessService()
    focusOrLaunch()
    monitor = Timer.scheduledTimer(timeInterval: 1.5, target: self, selector: #selector(checkHarnessWindow), userInfo: nil, repeats: true)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    authenticationAttempts = 0
    windowlessChecks = 0
    kickstartHarnessService()
    focusOrLaunch()
    return false
  }

  func applicationWillTerminate(_ notification: Notification) {
    monitor?.invalidate()
    voicePanelServer?.stop()
    stopHarnessService()
    guard !chromeEnded else { return }
    chromeApplication?.terminate()
  }

  private func focusOrLaunch() {
    // Readiness probes shell out to curl/launchctl and must never block the
    // main thread: run them in the background and apply the result back on
    // the main queue. The overlap guard keeps the 0.25s retry cadence from
    // stacking probes while a slow probe is still in flight.
    guard !isProbingService else { return }
    isProbingService = true
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let authenticatedURL = self?.authenticatedTargetURL()
      let ready = authenticatedURL.map { self?.serviceIsReady($0) ?? false } ?? false
      DispatchQueue.main.async { [weak self] in
        self?.isProbingService = false
        self?.handleFocusOrLaunch(authenticatedURL: ready ? authenticatedURL : nil)
      }
    }
  }

  private func handleFocusOrLaunch(authenticatedURL: String?) {
    guard let authenticatedURL else {
      authenticationAttempts += 1
      if authenticationAttempts >= 240 {
        presentError("The shared Harness service could not start on port 3083. Reopen this app to retry.")
        NSApp.terminate(nil)
      } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
          self?.focusOrLaunch()
        }
      }
      return
    }
    authenticationAttempts = 0
    if let running = managedChrome(), !running.isTerminated {
      chromeLifecycleStarted = true
      windowlessChecks = 0
      if launchedChromeURL() == authenticatedURL {
        switch managedChromeWindowState(running.processIdentifier) {
        case .visible:
          chromeWindowSeen = true
          running.unhide()
          running.activate(options: [.activateAllWindows])
          raiseManagedChromeWindow()
        case .unknown:
          break
        case .windowless:
          // Windowless but never seen (startup, window still opening) or
          // unknown list state handled above: wait, do not quit. A stale
          // windowless process for an already-seen window is relaunched.
          if chromeWindowSeen, pendingChromeURL == nil {
          // Stale process with no window (user closed it, or a crash left
          // it behind): relaunch the window so Dock reopen always works.
          pendingChromeURL = authenticatedURL
          if !running.terminate() {
            pendingChromeURL = nil
            presentError("Could not restart the dedicated Harness window.")
          }
          }
        }
      } else if pendingChromeURL == nil {
        pendingChromeURL = authenticatedURL
        if !running.terminate() {
          pendingChromeURL = nil
          presentError("Could not restart the dedicated Harness window.")
        }
      }
      return
    }
    launchChrome(authenticatedURL)
  }

  private func raiseManagedChromeWindow() {
    // Activating Chrome only fronts the app, not necessarily the Harness
    // window when other Chrome windows exist. Ask Chrome to order the
    // window holding this Mac's Harness origin first and restore it when
    // minimized. Best effort: if scripting control is denied, the plain
    // app activation above still applies. Runs off the main thread so a
    // first-run Automation prompt can never stall the launcher.
    let originPrefix = harnessOrigin.hasSuffix("/") ? harnessOrigin : harnessOrigin + "/"
    let script = """
      tell application "Google Chrome"
        repeat with w in windows
          try
            repeat with t in tabs of w
              if (URL of t starts with "\(originPrefix)") then
                set minimized of w to false
                set index of w to 1
                activate
                return
              end if
            end repeat
          end try
        end repeat
      end tell
      """
    DispatchQueue.global(qos: .userInitiated).async {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
      process.arguments = ["-e", script]
      process.standardOutput = Pipe()
      process.standardError = Pipe()
      try? process.run()
      process.waitUntilExit()
    }
  }

  private func kickstartHarnessService() {
    let domain = "gui/\(getuid())"
    guard !runLaunchctl(["kickstart", "\(domain)/\(launchAgentLabel)"]) else { return }
    _ = runLaunchctl(["bootstrap", domain, launchAgentPlist.path])
    _ = runLaunchctl(["kickstart", "\(domain)/\(launchAgentLabel)"])
  }

  private func stopHarnessService() {
    _ = runLaunchctl(["bootout", "gui/\(getuid())/\(launchAgentLabel)"])
  }

  private func runLaunchctl(_ arguments: [String]) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    process.arguments = arguments
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  private func serviceIsReady(_ authenticatedURL: String) -> Bool {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
    process.arguments = [
      "--fail", "--silent", "--max-time", "2",
      "--output", "/dev/null", authenticatedURL
    ]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      return process.terminationStatus == 0
    } catch {
      return false
    }
  }

  private func readServiceLogTail(maxBytes: UInt64 = 65536) -> String? {
    // The service log grows across restarts: only scan the tail so startup
    // probes stay O(1) instead of re-reading the whole file every 0.25s.
    guard let handle = try? FileHandle(forReadingFrom: serviceLog) else { return nil }
    defer { try? handle.close() }
    let end = (try? handle.seekToEnd()) ?? 0
    let start = end > maxBytes ? end - maxBytes : 0
    try? handle.seek(toOffset: start)
    let data = (try? handle.readToEnd()) ?? Data()
    var text = String(data: data, encoding: .utf8) ?? ""
    // A tail cut can split a line: drop the first partial line unless we
    // started at the beginning of the file.
    if start > 0, let newline = text.firstIndex(of: "\n") {
      text = String(text[text.index(after: newline)...])
    }
    return text
  }

  private func authenticatedTargetURL() -> String? {
    // Newest token wins. For a long-running service the original token line
    // may have scrolled beyond the 64 KiB tail, so fall back to the secure
    // cached copy (chrome.url, 0600) when the tail has no match. The caller
    // still gates on serviceIsReady, so a stale cached token (service
    // restarted with a fresh token) simply fails the probe and we retry.
    if let text = readServiceLogTail(),
       let fresh = findHarnessURL(in: text) {
      return fresh
    }
    guard let cached = launchedChromeURL(), isHarnessURL(cached) else { return nil }
    return cached
  }

  private func findHarnessURL(in text: String) -> String? {
    let prefix = "dsh web: "
    for line in text.split(whereSeparator: \.isNewline).reversed() {
      guard line.hasPrefix(prefix) else { continue }
      let value = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespacesAndNewlines)
      if isHarnessURL(value) { return value }
    }
    return nil
  }

  private func isHarnessURL(_ value: String) -> Bool {
    guard let components = URLComponents(string: value),
          components.scheme == "http",
          components.host == "127.0.0.1",
          components.port == 3083,
          components.path == "/",
          components.fragment == nil,
          let items = components.queryItems,
          items.count == 1,
          items[0].name == "token",
          let token = items[0].value,
          !token.isEmpty,
          token.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }) else { return false }
    return true
  }

  private func managedChrome() -> NSRunningApplication? {
    if let running = chromeApplication, !running.isTerminated { return running }
    if let raw = try? String(contentsOf: pidFile, encoding: .utf8),
       let pid = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
       let running = NSRunningApplication(processIdentifier: pid),
       running.bundleIdentifier == "com.google.Chrome",
       isManagedChromeProcess(pid) {
      chromeApplication = running
      return running
    }
    guard let running = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleIdentifier == "com.google.Chrome" && isManagedChromeProcess($0.processIdentifier)
    }) else { return nil }
    chromeApplication = running
    try? String(running.processIdentifier).write(to: pidFile, atomically: true, encoding: .utf8)
    return running
  }

  private func isManagedChromeProcess(_ pid: pid_t) -> Bool {
    let process = Process()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/ps")
    process.arguments = ["-p", String(pid), "-o", "command="]
    process.standardOutput = output
    process.standardError = Pipe()
    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0,
            let command = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) else { return false }
      return command.contains("--user-data-dir=\(chromeProfile.path)")
        && command.contains("--app=\(harnessOrigin)")
    } catch {
      return false
    }
  }

  private func launchedChromeURL() -> String? {
    try? String(contentsOf: urlFile, encoding: .utf8)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func launchChrome(_ authenticatedURL: String) {
    let chrome = URL(fileURLWithPath: chromeBinary)
    guard FileManager.default.isExecutableFile(atPath: chrome.path) else {
      presentError("Google Chrome was not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
      NSApp.terminate(nil)
      return
    }
    // Fresh process: no window has been seen yet, so the windowless monitor
    // must wait for the first window instead of quitting during startup.
    chromeWindowSeen = false
    windowlessChecks = 0
    do {
      try FileManager.default.createDirectory(at: supportDirectory, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: chromeProfile, withIntermediateDirectories: true)
      let process = Process()
      process.executableURL = chrome
      process.arguments = [
        "--app=\(authenticatedURL)",
        "--user-data-dir=\(chromeProfile.path)",
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check"
      ]
      chromeLaunchInProgress = true
      try process.run()
      try authenticatedURL.write(to: urlFile, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: urlFile.path)
      adoptLaunchedChrome(attemptsRemaining: 40)
    } catch {
      chromeLaunchInProgress = false
      presentError("Could not launch Google Chrome: \(error.localizedDescription)")
      NSApp.terminate(nil)
    }
  }

  private func adoptLaunchedChrome(attemptsRemaining: Int) {
    if let running = managedChrome() {
      chromeLaunchInProgress = false
      chromeLifecycleStarted = true
      running.unhide()
      running.activate(options: [.activateAllWindows])
      return
    }
    guard attemptsRemaining > 0 else {
      chromeLaunchInProgress = false
      presentError("Google Chrome started, but the dedicated Harness window could not be found.")
      NSApp.terminate(nil)
      return
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
      self?.adoptLaunchedChrome(attemptsRemaining: attemptsRemaining - 1)
    }
  }

  @objc private func checkHarnessWindow() {
    guard chromeLifecycleStarted, !chromeLaunchInProgress else { return }
    guard let running = managedChrome() else {
      windowlessChecks = 0
      chromeWindowSeen = false
      chromeDidTerminate()
      return
    }
    // X closes the --app window but leaves the Chrome process behind with no
    // windows. Quit only after SIX consecutive windowless ticks (~9 s) AND
    // only if a window was previously seen for this Chrome process. The
    // list query uses optionAll (NOT onScreenOnly) so minimized windows,
    // windows on other Spaces/desktops, and hidden windows still count as
    // present; fullscreen transitions and Mission Control blips ride out the
    // consecutive-tick requirement. Unknown list results (nil/empty, e.g.
    // permission denial or a transient system error) never count toward quit.
    // CGWindowList is permission-free and cheap enough for the 1.5 s tick.
    switch managedChromeWindowState(running.processIdentifier) {
    case .visible:
      chromeWindowSeen = true
      windowlessChecks = 0
    case .unknown:
      break
    case .windowless:
      guard chromeWindowSeen else { return }
      windowlessChecks += 1
      if windowlessChecks >= 6 {
        windowlessChecks = 0
        chromeEnded = true
        try? FileManager.default.removeItem(at: pidFile)
        try? FileManager.default.removeItem(at: urlFile)
        running.terminate()
        NSApp.terminate(nil)
      }
    }
  }

  private enum ManagedChromeWindowState {
    case visible
    case windowless
    case unknown
  }

  private func managedChromeWindowState(_ pid: pid_t) -> ManagedChromeWindowState {
    // optionAll: list every window (on-screen AND off-screen/minimized/other
    // Space). optionOnScreenOnly MUST NOT be used here: it omits minimized
    // windows, windows on other Spaces, and windows mid fullscreen
    // transition, which would cause a false quit.
    guard let list = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID) as? [[String: Any]],
          !list.isEmpty else { return .unknown }
    let key = kCGWindowOwnerPID as String
    for entry in list {
      if let owner = (entry[key] as? NSNumber)?.int32Value, owner == pid { return .visible }
    }
    return .windowless
  }

  private func chromeDidTerminate() {
    chromeApplication = nil
    chromeWindowSeen = false
    try? FileManager.default.removeItem(at: pidFile)
    try? FileManager.default.removeItem(at: urlFile)
    if let replacement = pendingChromeURL {
      pendingChromeURL = nil
      launchChrome(replacement)
      return
    }
    guard !chromeEnded else { return }
    chromeEnded = true
    NSApp.terminate(nil)
  }

  private func presentError(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "DeepSeek Harness Shared"
    alert.informativeText = message
    alert.alertStyle = .critical
    alert.runModal()
  }
}

let app = NSApplication.shared
let delegate = HarnessAppDelegate()
app.delegate = delegate
app.run()

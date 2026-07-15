import AppKit
import Darwin
import Foundation

private let appTitle = "Codex Inter-Agent Messaging Installer"

final class InstallerDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var cliField: NSTextField!
    private var homeField: NSTextField!
    private var installCLI: NSButton!
    private var installButton: NSButton!
    private var cancelButton: NSButton!
    private var progress: NSProgressIndicator!
    private var status: NSTextView!
    private var process: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func label(_ text: String, frame: NSRect) -> NSTextField {
        let view = NSTextField(labelWithString: text)
        view.frame = frame
        view.font = .systemFont(ofSize: 13, weight: .medium)
        return view
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 760, height: 590),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = appTitle
        window.isReleasedWhenClosed = false
        window.delegate = self
        guard let content = window.contentView else { return }

        let title = NSTextField(labelWithString: "Install Codex Inter-Agent Messaging")
        title.frame = NSRect(x: 34, y: 520, width: 690, height: 34)
        title.font = .systemFont(ofSize: 25, weight: .semibold)
        content.addSubview(title)

        let intro = NSTextField(wrappingLabelWithString: "Adds the local Codex plugin and companion CLI for this macOS user. The installer does not register agents, choose identities, or change task histories.")
        intro.frame = NSRect(x: 36, y: 474, width: 680, height: 42)
        intro.textColor = .secondaryLabelColor
        content.addSubview(intro)

        content.addSubview(label("Public Codex CLI (optional; auto-detected when blank)", frame: NSRect(x: 36, y: 435, width: 500, height: 20)))
        cliField = NSTextField(frame: NSRect(x: 36, y: 400, width: 585, height: 28))
        cliField.placeholderString = "~/.local/bin/codex"
        content.addSubview(cliField)
        let cliBrowse = NSButton(title: "Browse…", target: self, action: #selector(browseCLI))
        cliBrowse.frame = NSRect(x: 632, y: 399, width: 92, height: 30)
        content.addSubview(cliBrowse)

        content.addSubview(label("Codex data directory", frame: NSRect(x: 36, y: 363, width: 300, height: 20)))
        homeField = NSTextField(frame: NSRect(x: 36, y: 328, width: 585, height: 28))
        homeField.stringValue = NSString(string: "~/.codex").expandingTildeInPath
        content.addSubview(homeField)
        let homeBrowse = NSButton(title: "Browse…", target: self, action: #selector(browseHome))
        homeBrowse.frame = NSRect(x: 632, y: 327, width: 92, height: 30)
        content.addSubview(homeBrowse)

        installCLI = NSButton(checkboxWithTitle: "Install the exact supported Codex CLI from OpenAI when no compatible public CLI is available", target: nil, action: nil)
        installCLI.frame = NSRect(x: 36, y: 287, width: 690, height: 24)
        installCLI.state = .on
        content.addSubview(installCLI)

        let scroll = NSScrollView(frame: NSRect(x: 36, y: 92, width: 688, height: 176))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        status = NSTextView(frame: scroll.bounds)
        status.isEditable = false
        status.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        status.string = "Ready. Review the selections, then choose Install."
        scroll.documentView = status
        content.addSubview(scroll)

        progress = NSProgressIndicator(frame: NSRect(x: 36, y: 66, width: 688, height: 14))
        progress.style = .bar
        progress.isIndeterminate = true
        progress.isHidden = true
        content.addSubview(progress)

        cancelButton = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancelButton.frame = NSRect(x: 524, y: 24, width: 96, height: 32)
        content.addSubview(cancelButton)
        installButton = NSButton(title: "Install", target: self, action: #selector(install))
        installButton.frame = NSRect(x: 628, y: 24, width: 96, height: 32)
        installButton.keyEquivalent = "\r"
        content.addSubview(installButton)
    }

    @objc private func browseCLI() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url { cliField.stringValue = url.path }
    }

    @objc private func browseHome() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url { homeField.stringValue = url.path }
    }

    @objc private func cancel() {
        if process == nil { NSApp.terminate(nil) }
    }

    @objc private func install() {
        guard process == nil else { return }
        guard let payload = Bundle.main.resourceURL?.appendingPathComponent("payload"),
              FileManager.default.fileExists(atPath: payload.appendingPathComponent("scripts/install-plugin-macos.sh").path)
        else {
            showFailure("The installer payload is missing. Download the complete installer again.")
            return
        }
        let home = homeField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if home.isEmpty {
            showFailure("Choose a Codex data directory.")
            return
        }

        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        var arguments = [
            payload.appendingPathComponent("scripts/install-plugin-macos.sh").path,
            "--repository-root", payload.path,
            "--codex-home", NSString(string: home).expandingTildeInPath
        ]
        let cli = cliField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cli.isEmpty { arguments += ["--codex-executable", NSString(string: cli).expandingTildeInPath] }
        if installCLI.state == .on { arguments.append("--install-codex-cli") }
        task.arguments = arguments
        var environment = ProcessInfo.processInfo.environment
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser.path
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(homeDirectory)/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        task.environment = environment
        task.standardOutput = pipe
        task.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.append(text) }
        }
        task.terminationHandler = { [weak self] completed in
            pipe.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async { self?.finish(exitCode: completed.terminationStatus) }
        }

        installButton.isEnabled = false
        cancelButton.isEnabled = false
        cliField.isEnabled = false
        homeField.isEnabled = false
        installCLI.isEnabled = false
        progress.isHidden = false
        progress.startAnimation(nil)
        status.string = "Starting installation…\n"
        process = task
        do { try task.run() } catch { finish(exitCode: -1, launchError: error.localizedDescription) }
    }

    private func append(_ text: String) {
        status.textStorage?.append(NSAttributedString(string: text))
        status.scrollToEndOfDocument(nil)
    }

    private func finish(exitCode: Int32, launchError: String? = nil) {
        progress.stopAnimation(nil)
        progress.isHidden = true
        process = nil
        if let launchError { append("\nCould not start installer: \(launchError)\n") }
        if exitCode == 0 {
            append("\nInstallation completed. Open a new Codex task to discover the plugin.\n")
            installButton.title = "Done"
            installButton.isEnabled = true
            installButton.action = #selector(done)
        } else {
            append("\nInstallation failed (exit \(exitCode)). Review the details above.\n")
            cancelButton.title = "Close"
            cancelButton.isEnabled = true
            installButton.title = "Retry"
            installButton.isEnabled = true
        }
    }

    private func showFailure(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Installation cannot continue"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.runModal()
    }

    @objc private func done() { NSApp.terminate(nil) }
}

extension InstallerDelegate: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool { process == nil }
}

if CommandLine.arguments.contains("--self-test") {
    let resource = Bundle.main.resourceURL?.appendingPathComponent("payload/scripts/install-plugin-macos.sh").path ?? ""
    let exists = FileManager.default.fileExists(atPath: resource)
    let result: [String: Any] = [
        "status": exists ? "passed" : "failed",
        "surface": "macos-appkit-installer",
        "architecture": ProcessInfo.processInfo.machineArchitecture,
        "payloadPresent": exists
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(exists ? 0 : 1)
}

let application = NSApplication.shared
let delegate = InstallerDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()

private extension ProcessInfo {
    var machineArchitecture: String {
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        return String(cString: machine)
    }
}

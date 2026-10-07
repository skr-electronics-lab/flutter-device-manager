# Flutter Device Manager

<p align="center">
  <img src="media/icon.png" width="120" height="120" alt="Flutter Device Manager" style="border-radius: 20px;" />
</p>

<p align="center">
  <strong>The all-in-one Flutter & Android developer companion by <a href="https://skrelectronicslab.com">SKR Electronics Lab</a></strong>
</p>

A modern, production-ready VS Code extension for Flutter and Android developers. It brings a clean, native device dashboard directly inside VS Code: connect wirelessly over Wi-Fi, pair using QR codes, mirror device screens with **scrcpy**, forward ports with **adb reverse**, inspect Logcat with quick filters, dispatch deep links, capture screenshots to your clipboard, and manage project builds — all without leaving your editor.

---

## Key Features

### 1. Device Dashboard & Card Management
- Automatic detection of physical USB devices, Wi-Fi devices, and Android emulators.
- Displays accurate device model, brand, Android OS release, API level, IP address, and real-time battery status.
- Symmetrical, native VS Code styling matching any dark/light theme.
- **Smart Stale Device Cleanup**: Automatically prunes duplicate offline sockets and ghost endpoints when reconnecting.
- **Dedicated Offline Section**: Keeps disconnected devices isolated with 1-click **Clear Offline** pruning.

### 2. Scrcpy Screen Mirroring (1-Click)
- Launch ultra-low-latency, high-performance screen mirroring directly from the device card or details panel using **scrcpy**.
- Runs in a detached, dedicated always-on-top window with full keyboard and mouse control.

### 3. Network Traffic & Port Forwarding (adb reverse)
- Built-in reverse proxy tool (`adb reverse tcp:<port> tcp:<port>`).
- Forward backend dev ports (e.g. `8080`, `3000`, `5000`) so apps running on physical Wi-Fi or USB devices can query `http://localhost:<port>` without modifying device network settings.
- View active forwards and remove or clear them in 1 click.

### 4. Real-Time Logcat Viewer with Auto-Scroll & Presets
- Live streaming output from ADB and resident Flutter processes.
- **Auto-Scroll Control**: Locks to the latest line by default, and gently pauses when you scroll up to inspect stack traces. Toggle auto-scroll on/off at any time.
- **1-Click Quick Preset Filters**:
  - **All Logs**: Complete unfiltered stream.
  - **Flutter Only**: Isolates flutter engine and app framework tags.
  - **Fatal Crashes**: Highlights fatal exceptions, crashes, and AndroidRuntime errors.
  - **Network / HTTP**: Captures Dio, OkHttp, Retrofit, and HTTP socket traffic.
- Full-text search, level filter (Verbose, Debug, Info, Warn, Error), pause/resume, clipboard copy, and `.txt` export.

### 5. Deep Link & Intent Dispatcher
- Test app navigation and universal links in seconds without opening command prompt:
  ```bash
  adb shell am start -a android.intent.action.VIEW -d "myapp://checkout?id=42"
  ```
- Type any custom URL scheme or HTTPS deep link and launch it directly on the connected phone.

### 6. App Management & Quick Toggles
- **Clear App Data & Cache**: Instant `pm clear` for third-party packages to reset state.
- **App Settings / Permissions**: 1-click shortcut into the phone's Application Info settings page.
- **Toggle Wi-Fi**: Quick switch to test offline/online app behavior.
- **Install APK**: Pick any APK file from your file system with real-time install progress.
- **Uninstall App**: Select from installed third-party packages.
- **Open Shell**: Launches an interactive ADB shell terminal in VS Code.

### 7. Screenshot to Clipboard & Pictures
- Capture high-resolution device screenshots.
- Copies the image directly to your OS clipboard (ready to paste into GitHub, Slack, Jira, or Figma with `Ctrl+V`), while simultaneously saving a backup file to your Pictures folder.

### 8. Wireless Wi-Fi Debugging & QR Pairing
- **QR Code Pairing (Android 11+)**: Displays an interactive QR code with a live 60-second ticking countdown timer. Scan with your phone's camera to pair wirelessly in seconds.
- **6-Digit Pairing Code**: Enter IP, pairing port, and 6-digit code for standard Android 11+ pairing.
- **Classic TCP/IP (Android 10 and below)**: Enable wireless over USB via `adb tcpip 5555`.
- **Device History & Auto-Reconnect**: Remembers previously connected devices. Reconnect individually with ⚡ **Connect** or reconnect all saved phones simultaneously with ⚡ **Auto-Connect All**.

### 9. Flutter Command Toolbar
- Trigger `flutter run` in **Debug**, **Profile**, or **Release** mode.
- Interactive hot reload (`r`), hot restart (`R`), stop, and `flutter attach`.
- Project maintenance tools: `flutter clean`, `pub get`, `pub upgrade`, `flutter doctor`, `flutter analyze`, and `dart format`.
- Automatically transitions to the **Logs** tab on tool execution so you can inspect build progress in real time.

---

## Requirements

1. **Android SDK Platform-Tools (`adb`)**:
   - Ensure `adb` is on your system `PATH`, or set `flutterDeviceManager.adbPath` in VS Code settings.
2. **Flutter SDK**:
   - Ensure `flutter` is on your system `PATH`, or set `flutterDeviceManager.flutterPath` in VS Code settings.
3. *(Optional)* **scrcpy**:
   - For screen mirroring, install [scrcpy](https://github.com/Genymobile/scrcpy) (`choco install scrcpy` or `scoop install scrcpy` on Windows, `brew install scrcpy` on macOS).

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `flutterDeviceManager.adbPath` | `""` | Custom path to the `adb` executable. Auto-detected if empty. |
| `flutterDeviceManager.flutterPath` | `""` | Custom path to the `flutter` executable. Auto-detected if empty. |
| `flutterDeviceManager.autoRefreshMs` | `5000` | Device poll interval in milliseconds. |
| `flutterDeviceManager.rememberLastDevice` | `true` | Restore last selected device on startup. |
| `flutterDeviceManager.autoReconnect` | `true` | Auto-reconnect saved wireless devices on startup. |
| `flutterDeviceManager.screenshotDir` | `""` | Custom folder for screenshots (defaults to `~/Pictures`). |
| `flutterDeviceManager.recordingDir` | `""` | Custom folder for screen recordings. |

---

## Support & Community

If Flutter Device Manager saves you time, consider supporting future development:

[![Support on Ko-fi](https://img.shields.io/badge/Support_on-Ko--fi-ff5e5b?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/skrelectronicslab)

- **Author**: SK Raihan (SKR Electronics Lab)
- **Website**: [skrelectronicslab.com](https://skrelectronicslab.com)
- **YouTube**: [@skr_electronics_lab](https://youtube.com/@skr_electronics_lab)
- **Instagram**: [@skr_electronics_lab](https://instagram.com/skr_electronics_lab)
- **Twitter / X**: [@skrelectronics](https://twitter.com/skrelectronics)

---

## License

MIT License. Designed and crafted for developers.

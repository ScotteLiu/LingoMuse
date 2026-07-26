# LingoMuse Privacy Policy

Last updated: July 26, 2026

LingoMuse is designed around one principle: translation content stays on the user's computer.

## Data we do not collect

LingoMuse creates no account and includes no analytics, advertising, or telemetry SDK. It does not collect translation text, clipboard contents, usage records, device information, or identity information.

## Local processing

The lightweight edition sends translation requests only to `http://127.0.0.1:11434`. The complete offline edition sends them only to its managed engine at `http://127.0.0.1:11435`. Both are loopback addresses handled on the user's computer.

Clipboard text is read only when double-copy translation is enabled and two `Ctrl+C` actions occur within the configured trigger window. LingoMuse does not continuously store untriggered clipboard contents.

## Local storage

Settings are stored in Electron's local user-data directory. Translation history is disabled by default. When enabled, it remains local and can be disabled and erased immediately from the application.

## Local speech

Speech uses only voices reported by the operating system as `localService`. If no matching local voice is available, LingoMuse stops instead of sending text to a remote speech provider.

## External connections

The application opens the official Ollama download page only after an explicit user action. A local Ollama installation may download a model selected by the user. LingoMuse itself does not connect to a paid translation service.

## Engine address protection

Advanced settings accept only HTTP loopback addresses using `127.0.0.1`, `localhost`, or `::1`. Remote addresses are rejected and replaced with the local default.

For the Traditional Chinese version, see [PRIVACY.md](PRIVACY.md).


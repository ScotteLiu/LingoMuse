# Security Policy

## Supported version

The current `1.x` release line receives security fixes.

## Design notes

- The renderer uses context isolation and has no direct Node.js access.
- The preload exposes a narrow, allow-listed IPC surface.
- Navigation outside the packaged application is blocked.
- Translation text is sent to the configured Ollama endpoint, which defaults to loopback only.
- Global keyboard observation checks only the modifier state and the `C` key needed for the double-copy gesture; it does not store keystrokes.

## Reporting

Please report security issues privately to the project maintainer. Do not include sensitive clipboard or translation content in a public report.

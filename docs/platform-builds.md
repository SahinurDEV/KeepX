# Platform builds

No desktop, mobile, or extension artifact has been built. Download pages therefore mark those platforms unavailable and do not render a file link.

## Web

The web app is the supported client. Development and production commands are in the root `README.md`.

## Desktop (not started)

Planned shape when implementation begins:

- Electron loads the deployed web origin, or a packaged build of `apps/web`
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- Navigation limited to the app origin
- Preload script exposes a small typed API for notifications and the global shortcut
- Packages: Windows NSIS, macOS dmg, Linux AppImage
- Signing and notarization need developer certificates that are not in this environment

Do not enable the Windows, macOS, or Linux download cards until a package has been produced on that platform and its checksum is written into `packages/shared/src/downloads.ts`.

## Mobile (not started)

Planned shape: Expo app using `@vela/shared`, `@vela/validation`, and `@vela/api-client`.

Store release needs an Apple Developer account, Android signing keys, notification permission copy, and a development build for any native module. Those are not configured.

## Browser extension (not started)

Planned shape: Manifest V3, `storage` and a host permission for the API origin only. Optional `activeTab` used only after a click that saves the current tab title and URL. No broad content-script access.

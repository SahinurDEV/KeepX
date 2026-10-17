# Platform builds

macOS and iOS have no install file yet. Their download cards do not render a file link.

## Web

The web app is the supported client. Development and production commands are in the root `README.md`.

## Desktop

`apps/desktop` is an Electron shell. It loads `KEEPX_WEB_ORIGIN` (default `http://127.0.0.1:3000`). The window uses `contextIsolation`, no Node integration, and the sandbox. Navigation stays on that origin. Other http links open in the system browser. The preload script exposes `notify` and a listener for Ctrl+Shift+K, which focuses quick add.

The verified Windows file is `apps/web/public/downloads/KeepX-0.1.0-win-x64.exe`. It is a portable executable, unsigned, because this environment has no code-signing certificate. Its checksum is in `packages/shared/src/catalog.ts`. A Linux AppImage can be built in Docker from the Linux Electron binary, but GitHub rejects files over 100 MB, so that file is not hosted in this repo and the download catalog marks Linux unavailable. A macOS package still has to be built on a Mac.

```
pnpm --dir apps/desktop start
pnpm --dir apps/desktop package
```

`package` rebuilds the portable exe into `apps/desktop/release`. Copy it over the public file only after the hash matches.

## Mobile

`apps/mobile` is an Expo app. It shares `@vela/shared`, `@vela/validation`, and `@vela/api-client` with the web app. It is a native React Native client that calls the API — not a WebView of the website. Sign-in posts to the API, creates a bearer token named Android, and keeps that token in memory for the session. The source has Inbox, Today, and All (add from Inbox, tap to complete, due dates, Sign out). The published APK still matches the earlier Inbox-only build until the next assemble succeeds; Ninja fails when the monorepo path contains parentheses.

The verified file is `apps/web/public/downloads/KeepX-0.1.0-android.apk`. It is an unsigned debug APK for arm64-v8a, not a Play Store listing. The checksum is in `packages/shared/src/catalog.ts`.

Ninja cannot create build directories when the project path contains parentheses. This workspace path does, so the APK was assembled from a copy of the app at a path without them:

```
gradlew assembleDebug --no-daemon -PreactNativeArchitectures=arm64-v8a
```

That command needs `JAVA_HOME` and `ANDROID_HOME`. iOS still has to be built on a Mac, so that download card stays off.

## Browser extensions

`apps/extension` packs three files:

- `KeepX-0.1.0-chrome.zip` and `KeepX-0.1.0-edge.zip` are the same Manifest V3 extension. Load them unpacked. They are not store listings.
- `KeepX-0.1.0-firefox.xpi` is the Firefox build. Load it as a temporary add-on.

Each one may call only `http://127.0.0.1:3000`, and only with a bearer token created in Settings. The actions are quick add, save the open tab, and links to open KeepX or Settings. There is no content script.

## Gmail

`apps/gmail-addon` is an Apps Script project in `KeepX-0.1.0-gmail.zip`. Google runs it, so it cannot call localhost. It is not published to the Marketplace. `INSTALL.txt` in the zip is the install path.

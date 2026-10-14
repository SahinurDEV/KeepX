# Repository inspection — 2026-10-14

## Workspace

- Path: `C:\Users\Sahinur\Desktop\New folder (3)`
- Git repository: no
- Files present before this work: none (recursive search returned 0 files)
- Node.js: v24.5.0
- npm: 10.9.2
- pnpm: 9.15.9
- Corepack: 0.33.0

There was no existing application, package manifest, or configuration to preserve.

## REA

The first session had no REA MCP server. The catalog then exposed only `cursor`, Gmail, Drive, and Outlook. Gmail, Drive, and Outlook were not used for product research.

REA is now installed from [morluto/rea](https://github.com/morluto/rea), npm package `rea-agents` 6.4.0. Setup status was `ready`. Cursor registration state is `aligned`. The bundled skill at `C:\Users\Sahinur\.agents\skills\reverse-engineer-anything` reports version 37 and 170 tools, state `aligned`.

The default Node on PATH is v24.5.0. `rea-agents` requires Node.js 22.x at or above 22.19, 24.x at or above 24.11, or 26 or newer. The system Node at `C:\Program Files\nodejs` is v22.17.1, which is also outside that range. A portable Node v22.23.3 was downloaded from nodejs.org, hash-checked, and left at `%LOCALAPPDATA%\rea-node\node-v22.23.3-win-x64`. The package itself lives at `%LOCALAPPDATA%\rea-node\rea-agents`. Neither install replaced the system Node.

`%USERPROFILE%\.cursor\mcp.json` now starts that portable Node with `scripts\rea.mjs mcp`. The previous file contained an empty `mcpServers` object. Setup wrote `mcp.json.rea.backup`. Hopper, Ghidra, and IDA were not installed. Doctor reports those native engines as not configured, so `environment_healthy` is false. JavaScript and Electron static analysis does not need them.

This Cursor session still does not list an REA namespace. The client has to reload MCP after the registration change before those tools can be called here. No REA tool was invoked against a target, so this is not a completed product investigation.

## Reference product

No local path to an owned or authorized copy of TickTick was provided. REA was not pointed at a third-party binary, installer, or website. Feature scope comes from the written product brief and from ordinary task-management patterns (lists, due dates, priorities, recurrence, calendar placement, search).

Proprietary source, branding, icons, and visual assets were not copied. Public marketing pages in this repo use original copy and an original mark.

## Decisions recorded before implementation

- Build a pnpm + Turborepo monorepo.
- Ship a real web app and API first. Do not add desktop, mobile, or extension packages until they can be built and verified.
- Brand defaults to **Vela**. The internal codename remains **Project Orbit**. The public name is the `APP_NAME` / `NEXT_PUBLIC_APP_NAME` setting.
- Persist data in MongoDB through Mongoose. Tests use `mongodb-memory-server` so they do not need Atlas credentials.
- Authenticate with httpOnly session cookies and bcrypt password hashes.
- Proxy `/api/v1` through the Next.js app so the session cookie stays on the web origin.
- Keep download buttons unavailable until a tested artifact and URL exist.
- Do not claim offline sync, push notifications, billing, or store distribution.

## Unresolved questions

- Cursor must reload MCP before this session can call REA tools. A local path to software that is owned or authorized for examination is still required before any analysis run.
- MongoDB Atlas connection string and hosting targets are not provided. Local development expects `MONGODB_URI`.
- SMTP credentials for account-recovery email are not provided. Recovery mail stays disabled.
- No Apple, Google Play, Microsoft, or extension-store accounts were provided.

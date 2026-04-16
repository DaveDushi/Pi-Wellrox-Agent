# Pi Wellrox Agent

Web-based chat interface for Pi — a general-purpose assistant by Wellrox.

## Setup

```bash
bun install
bun run dev
```

Open [http://localhost:3141](http://localhost:3141) in your browser.

## How it works

1. On launch, you'll be asked to authenticate with OpenAI Codex (if not already logged in)
2. Select a model for this session (required every launch)
3. Chat with Pi in the browser

## Installing on Windows (packaged app)

Distribute `release/Pi-Wellrox-Agent-Setup-<version>.exe` — the NSIS installer. Do **not** ship the loose `win-unpacked/` folder or a ZIP of it; Windows Mark-of-the-Web and antivirus frequently quarantine `ffmpeg.dll` from ZIP extractions, producing a `ffmpeg.dll was not found` system error on launch.

On first launch:

- If SmartScreen blocks the installer: **More info → Run anyway** (the app is not code-signed yet).
- If `ffmpeg.dll was not found` still appears after install: antivirus quarantined it. Restore it from quarantine or exclude `%LOCALAPPDATA%\Programs\pi-wellrox-agent\` in your AV, then relaunch.
- The app uses a single-instance lock and picks a free local port automatically — a second launch focuses the existing window instead of crashing on `EADDRINUSE`.

## Terminal Pi

The terminal Pi CLI shares the same `.pi/settings.json` configuration. After selecting a model in the web app, run `pi` in this directory and it will use the same provider and model settings.

## Project Structure

```
src/
  main.ts              — Entry point, starts Bun server on port 3141
  app.ts               — Hono routes (startup, chat, static files)
  agent/
    sharedModel.ts     — Read/write .pi/settings.json
    startup.ts         — OAuth + model selection flow
    createAgent.ts     — Pi agent session management
    systemPrompt.ts    — Non-coding assistant system prompt
public/
  index.html           — Single-page app
  app.js               — Client-side logic
  style.css            — Styles
.pi/                   — Local config (settings.json is gitignored)
skills/                — Shareable skill definitions
```

## Configuration

Local settings are stored in `.pi/settings.json` (not committed):

```json
{
  "defaultProvider": "openai-codex",
  "defaultModel": "gpt-5.4",
  "defaultThinkingLevel": "high"
}
```

Shared resources (committed):
- `skills/` — Skill definitions (markdown)
- `.pi/prompts/` — Custom prompt additions
- `.pi/extensions/` — Extensions
- `.pi/themes/` — Themes

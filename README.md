<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-dark.png">
    <img src="docs/brand/logo-light.png" width="380" alt="fasterwhisper — frontend">
  </picture>
</p>

A FOSS, cross-platform **dictation client** for a self-hosted
[faster-whisper-backend](https://github.com/v3DJG6GL/faster-whisper-backend)
(or any OpenAI-compatible transcription server).

Hold a hotkey (or toggle hands-free), speak into the focused field of **any**
application, and your words are transcribed by your own server and inserted in
place — with a floating "chip" overlay showing live voice activity.

> Status: **early development.** Runs against your own faster-whisper-backend; no paywall.
> Optional text translation uses the server's llama.cpp models — nothing leaves your infrastructure.

## Highlights

- **Two dictation modes** — *press-&-hold* and *hands-free toggle*, each with its
  own rebindable global hotkey and its own **Model Profile**.
- **Per-profile config** — server URL, model, API key, language, and
  **streaming vs. batch** endpoint are all set per profile and assigned per mode.
- **Streaming + batch** — live partial transcripts via the WebSocket endpoint, or
  chunked multipart for files.
- **Text insertion** — clipboard *Paste method* (default) or *Direct insertion*,
  with Auto-Enter and clipboard restore.
- **Floating chip overlay** with a live audio-level visualizer (Windows + X11;
  degrades to tray + sound on GNOME Wayland).
- **Transcribe tab** — file, link and batch transcription with speaker
  diarization, exports (SRT/VTT/LRC/…), and a searchable transcript history.
- **Translation** — dictate in one language, insert in another; re-translate
  saved transcripts through the server's text-translation models.
- **Settings sync** — per-setting switches decide what travels between devices
  through the server; the rest stays local.
- **In-app log viewer** for the session log the support flow asks for.
- Secure by design: API keys live in the OS secret store, not on disk.

## Tech stack

Tauri 2 (Rust core) + React 19 + Vite + TypeScript + Tailwind v4 + Motion.
Design system: **"Signal"** — warm dark-first chrome, an electric-amber signal
accent, and Hubot Sans / Mona Sans / Geist Mono (all OFL).

## Targets

Linux (primary: **KDE Plasma Wayland**; X11 fully supported; GNOME usable with
documented degradations) and Windows 10/11. x64 only.

## Development

```bash
pnpm install          # JS deps (also installs the OFL fonts + Tauri plugins)
pnpm build            # type-check + build the web UI
pnpm tauri:dev        # run the desktop app (requires the Rust toolchain)
pnpm tauri:build      # produce installers (.msi + .exe NSIS / .deb / AppImage)
```

Requires Node + pnpm, the Rust toolchain, and (on Linux) `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev`, `libasound2-dev` (audio capture) and
`libxkbcommon-dev` (Wayland keystroke injection) — the same set `.forgejo/workflows/ci.yml` installs.

## License

[AGPL-3.0-or-later](LICENSE).

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer).

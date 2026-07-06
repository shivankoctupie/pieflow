# PieFlow

A free, fully local AI voice keyboard for Windows. Hold a hotkey anywhere, speak naturally, and PieFlow types clean, polished text into whatever app has focus: browser, email, VS Code, Slack, any text field.

PieFlow transcribes with local Whisper, strips fillers ("um", "uh"), fixes punctuation and capitalization, resolves self-corrections ("let's meet Tuesday, wait no Friday" becomes "let's meet Friday"), expands snippets, applies per-app tone, and can rewrite selected text from a spoken instruction. No account, no login, no telemetry, no required API key. Everything stays on your machine in SQLite and local files.

## Download (Windows)

Grab the latest installer from the [Releases page](https://github.com/shivankoctupie/pieflow/releases), run it, and PieFlow installs to the Start menu.

The installer is not code-signed, so Windows SmartScreen may warn on first launch. Click "More info" then "Run anyway". You can verify what you are running: the full source is in this repo and you can build the installer yourself (see below).

Prefer to run from source? See [Launch](#launch).

## Launch

One command from the project folder:

```
npm start
```

First run does three one-time things automatically (watch the status chips on the Home screen):

1. Creates a private Python environment and installs faster-whisper (a few minutes).
2. Downloads the Whisper "base" model (~140 MB).
3. Asks Windows for microphone access if needed.

There is also a Windows installer: run `npm run dist` and grab `dist/PieFlow Setup 0.1.0.exe`. The installer version launches from the Start menu like any app.

### Prerequisites

- Node.js 18+ (`npm install` once, if you have not already)
- Python 3.9+ on PATH (only for the free local speech engine; if Python is missing, PieFlow tells you and you can either install it from python.org or add a cloud key in Settings)

## Using it

| Action | How |
|---|---|
| Dictate | Hold `Ctrl + Shift + Space`, speak, release |
| Hands-free dictation | Double-tap `Ctrl + Shift + Space`; press it again to stop |
| Submit after typing | End your sentence with "press enter" |
| New line / paragraph | Say "new line" or "new paragraph" |
| Snippets | Say a snippet trigger, e.g. "insert signature" |
| Command Mode | Select text anywhere, hold `Ctrl + Shift + K`, say an instruction ("make this more concise", "turn this into bullet points", "translate to Spanish") |

Both hotkeys are configurable in Settings. A small pill at the bottom of the screen shows listening / processing / typing state.

The dashboard (tray icon, or it opens on launch) has:

- **Home**: recent dictations grouped by day, searchable, with total words, average WPM, and day streak. Edit any entry to teach PieFlow your corrections.
- **Insights**: words per day, speaking speed, top apps.
- **Dictionary**: names and jargon Whisper should always get right, with "sounds like" variants.
- **Snippets**: trigger phrase to full text block.
- **Style**: per-app tone profiles (professional for email, casual for chat, code-aware for editors). Matched on the foreground process name.
- **Transforms**: saved Command Mode instructions you can invoke by name.
- **Scratchpad**: a quiet place to dictate.
- **Settings**: hotkeys, microphone, speech engine and model, cleanup mode, API keys, launch at startup.

## Windows permissions

- **Microphone**: Settings > Privacy and security > Microphone > "Let desktop apps access your microphone" must be on. PieFlow will simply record silence if it is off.
- **Admin windows**: text cannot be injected into elevated apps (an elevated PowerShell, regedit) unless you run PieFlow elevated too. This is a Windows security rule (UIPI), not a bug.
- No other permissions are needed. The global hotkey and typing work without accessibility settings on Windows.

## Free vs. keys

PieFlow is fully functional with no keys: local Whisper for speech, built-in rules for cleanup. Two optional upgrades:

- **Ollama** (free, local): if Ollama is running, PieFlow uses it for smarter cleanup and Command Mode. Any chat model works; small fast ones (`ollama pull qwen3:1.7b`) feel best for inline cleanup. Pick the model in Settings.
- **API keys** (paid, cloud): add an OpenAI or Groq key in Settings for faster transcription and higher-quality cleanup. Groq has a generous free tier at console.groq.com. Keys are stored only in `%APPDATA%\PieFlow\keys.json` and used directly against the provider; if a key stops working PieFlow falls back to local automatically.

Priority when several options exist: explicit setting first, then cloud key, then Ollama, then built-in rules. Nothing ever breaks by removing a key.

## Self-test results (run on this machine during the build)

- Opened Notepad, ran a spoken recording ("Um, hello there, this is a test of PieFlow. Let's meet on Tuesday, wait no, Friday. New paragraph. That is all, press enter.") through the full production pipeline. Notepad received:

  ```
  Hello there, this is a test of PieFlow. Let's meet on Friday.

  That is all.
  ```

  followed by an Enter press. Filler removed, self-correction resolved, paragraph break honored, submit executed. PASS.
- Live microphone dictation was also verified end to end (real speech captured by the mic, transcribed, cleaned, injected, logged to history with WPM).
- Dictionary: with "PieFlow (sounds like: pipe low, pie flow)" saved, Whisper itself started outputting "PieFlow" via the glossary bias. PASS.
- Command Mode: selected ~470 chars in Notepad, spoke "Turn this into bullet points", Ollama (qwen3:8b) rewrote it and the result replaced the selection. PASS.
- Clipboard is preserved across paste-injection (verified byte for byte). PASS.

## Troubleshooting

- **Nothing types**: check the target window is not elevated; try Settings > Typing > "Always paste".
- **Bad transcriptions**: add the words to Dictionary; or switch Local model to "small" in Settings (slower, more accurate); or add a Groq key.
- **"No speech detected"**: check Windows mic privacy toggle and the input device in Settings. The last raw recording is saved at `%APPDATA%\PieFlow\last-capture.wav`; play it to hear what PieFlow heard.
- **Command Mode says it needs an LLM**: start Ollama (`ollama serve`, with at least one model pulled) or add an API key.
- **Local engine stuck on setup**: install Python 3.9+ from python.org (check "Add python.exe to PATH"), restart PieFlow.

## Project layout

```
main/        Electron main process (hotkeys, pipeline, storage, sidecars)
preload/     contextBridge APIs for the two renderers
renderer/    dashboard UI and recorder overlay
python/      faster-whisper sidecar (JSON lines over stdio)
ps/          PowerShell injector sidecar (SendInput typing/paste, foreground info)
assets/      icons
```

See DECISIONS.md for why each piece is built the way it is.

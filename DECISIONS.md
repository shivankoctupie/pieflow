# PieFlow: Architecture Decisions

Log of every meaningful choice made while building PieFlow, in rough build order.

## Shell and language

- **Electron over Tauri.** Electron gives a battle-tested tray, window, and IPC story on Windows, and its bundled Chromium provides `getUserMedia` for mic capture with zero native audio dependencies. Tauri would be lighter but needs a Rust toolchain and a separate audio capture story.
- **Plain JavaScript, no TypeScript, no bundler.** The whole app is main process + two small vanilla renderers. Skipping the build step removed a whole class of toolchain failures and makes the project runnable with nothing but `npm install`. Tradeoff: no static types; mitigated by keeping modules small and single-purpose.

## Global hotkeys

- **uiohook-napi instead of Electron's globalShortcut.** `globalShortcut` only fires on key press, so push-to-talk (hold to record, release to stop) is impossible with it. uiohook-napi is an N-API prebuilt library (no rebuild against Electron ABI needed) that delivers raw global keydown/keyup events.
- **Track modifier state manually.** Discovered during testing that uiohook's `e.ctrlKey` flag stays false on Windows even while Ctrl is held. PieFlow keeps its own set of held keycodes and derives Ctrl/Shift/Alt from it. This was a real bug found by synthesizing hotkey presses with `keybd_event` and watching the hook.
- **Gestures:** hold at least 280 ms = push-to-talk; two taps under 450 ms apart = hands-free toggle; any combo press while hands-free = stop. One hotkey, three behaviors, matching Wispr Flow.

## Speech to text

- **faster-whisper in a Python sidecar** as the default free engine. Sturdiest local Whisper option on Windows: pip-installable, no compiler needed, ships CTranslate2 wheels, has built-in Silero VAD (`vad_filter=True`) so silence is trimmed without extra code. whisper.cpp would avoid Python but needs binary distribution per CPU/GPU variant.
- **The app creates its own venv** under `%APPDATA%\PieFlow\stt-venv` on first run (finds `py -3.12` / `python`, runs `python -m venv`, `pip install faster-whisper`) and reports progress in the dashboard. Model files cache under `%LOCALAPPDATA%\PieFlow\models` via `HF_HOME`.
- **Sidecar protocol is JSON lines over stdin/stdout.** Trivial to debug by hand, no ports, no gRPC dependency, survives long transcriptions.
- **Whisper's `initial_prompt` carries the personal dictionary** ("Glossary: PieFlow, ...") which biases recognition toward the user's terms. Verified in testing: "pipe low" became "PieFlow" once the dictionary entry existed.
- **Cloud STT (OpenAI whisper-1, Groq whisper-large-v3-turbo) is optional.** Engine "auto" prefers a configured key (faster than local), falls back to local Whisper on any cloud error. Keys absent = pure local, nothing breaks.

## Cleanup layer

- **Two-tier design: deterministic rules always run first, an LLM optionally polishes after.** The rules engine handles spoken commands ("new paragraph", "new line", trailing "press enter" = submit), filler removal (um/uh/erm), self-corrections ("Tuesday, wait no, Friday" keeps Friday; "scratch that" drops the previous sentence), repeated-word collapse, dictionary replacements, punctuation spacing, and capitalization. So the app is fully useful with zero LLM.
- **Self-correction heuristic:** on a marker like "wait no", drop as many words before the marker as the replacement clause has after it (capped at 6, never across punctuation). Simple, predictable, right for the common "X, wait no Y" pattern.
- **LLM provider priority: cloud key, then Ollama, then rules.** Rationale: a key is an explicit user opt-in for quality/speed; Ollama is free but hardware-dependent.
- **12-second LLM budget for dictation cleanup.** On this machine Ollama's qwen3:8b takes ~28 s per cleanup, which is unusable inline; if the LLM misses the window the rules result ships instead. Command Mode gets 180 s because it is an explicit user action.
- **Ollama thinking models:** requests set `think: false` and strip `<think>` blocks defensively (qwen3 was the installed model during development).

## Text injection

- **Persistent PowerShell sidecar using Win32 `SendInput`, not nut.js/robotjs.** robotjs needs a native rebuild against Electron's ABI (fragile), nut.js has licensing friction. PowerShell + `Add-Type` C# gives direct `SendInput` access with zero npm native dependencies, and a persistent process (JSON lines on stdin/stdout) avoids the ~1 s PowerShell startup per injection.
- **Two insertion paths:** `KEYEVENTF_UNICODE` typing for short text, clipboard paste (backup clipboard, set text, Ctrl+V, restore clipboard) for anything over 60 chars. Both verified in Notepad; the clipboard restore was confirmed to preserve prior clipboard content.
- **Typing is batched.** Sending each character as its own `SendInput` call let other input interleave and produced garbled text with repeated characters (found in testing). Batching up to 128 events per call fixed it completely.
- **Modifiers are force-released before injecting** so a user still holding the hotkey cannot corrupt the synthetic Ctrl+V.
- **Same sidecar reports the foreground app** (process name + window title) for style profiles and history, and performs the Ctrl+C selection grab for Command Mode.

## Storage

- **sql.js (WASM SQLite) instead of better-sqlite3.** better-sqlite3 is a native module that would need an Electron-ABI rebuild on the user's machine (needs Visual Studio build tools; too fragile for "runs out of the box"). sql.js is real SQLite compiled to WASM: same file format, zero native risk. The DB lives in memory and is debounce-flushed (500 ms) to `%APPDATA%\PieFlow\pieflow.db`, plus flushed on quit. Data volumes here (dictation history) are tiny, so the full-file write is irrelevant.
- **Settings are a plain JSON file**, not in SQLite, so a user can inspect or fix them by hand. API keys live in a separate `keys.json`, never leave the machine, and the renderer only ever receives masked previews.

## Audio capture

- **Capture happens in the overlay renderer** (the always-existing recorder pill window) via `getUserMedia` + AudioWorklet, so it works while the dashboard is closed. `backgroundThrottling: false` keeps capture healthy while the window is hidden.
- **Renderer resamples to 16 kHz mono and builds the WAV**, shipping one ArrayBuffer to main on stop. Whisper wants 16 kHz anyway, and raw PCM avoids codec dependencies entirely.
- **Voice processing (AEC/noise suppression/AGC) is a setting.** On by default; exposed because echo cancellation eats audio played through the speakers (discovered while trying to test with TTS through the speakers).

## Command Mode

- Selection is grabbed via synthetic Ctrl+C at hotkey press (while the user is still speaking, hiding the latency), instruction is transcribed, the LLM rewrites, and the result is pasted over the still-active selection. Spoken instructions that match a saved Transform name use that transform's full instruction. Without any LLM the overlay says exactly what to do (start Ollama or add a key) instead of failing silently.

## UI

- **Vanilla HTML/CSS/JS dashboard** matching the reference structure: left sidebar (Home, Insights, Dictionary, Snippets, Style, Transforms, Scratchpad, Settings at bottom), Home with welcome header, hero card, day-grouped Recent activity, right-side stats (total words, average WPM, day streak, dictation count) computed from real history. Charts are hand-rolled DOM bars, no chart library.
- **Overlay** is a frameless, transparent, click-through, always-on-top pill at bottom center showing listening (live level bars), processing, typing, done, and error states. Purple tint in Command Mode.
- **Dictionary learning:** editing a dictation in Recent activity diffs the words; single-word replacements become "misheard" variants on a dictionary entry, which then feed both the Whisper glossary prompt and the rules engine.

## Packaging

- **electron-builder NSIS one-click installer**, with `ps/` and `python/` asar-unpacked because external processes (powershell.exe, python.exe) cannot read inside app.asar. `npm start` remains the documented dev path.

## Known limitations (documented, not hidden)

- Elevated (admin) windows will not accept injected text unless PieFlow itself runs elevated (Windows UIPI).
- First run needs Python 3.9+ on PATH for local STT; otherwise the app says so and cloud keys still work.
- The learn-from-edits loop only sees edits made inside PieFlow's history page; edits made in the target app are invisible to it (Windows offers no clean way to observe them).
- Ollama quality/latency depends entirely on the installed model; an 8B reasoning model is too slow for inline cleanup on modest hardware, which is why the 12 s guard exists.

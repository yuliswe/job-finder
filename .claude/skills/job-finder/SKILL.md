---
name: job-finder
description: When user asks to use the cli (aka jobfinder) tool, or to drive/inspect the live TUI dashboard.
---

Read this file `__generated__/cli/help-menu.json` to understand the commands available in the cli tool. When user asks to use the cli tool, run the appropriate command and return the output to the user.

## Driving the live TUI dashboard (harness server)

When the user wants you to inspect or operate the live dashboard (the `jobfinder tui` view), use the harness control server. It runs the normal live TUI **and** exposes an HTTP API so you can read the screen and press keys on the same instance the user is watching.

### 1. Find (or start) a running harness

Each running harness publishes its connection info to `/tmp/jobfinder/harness.<pid>.json` (one file per instance, keyed by the TUI's process id) and removes it on exit. List them first:

```bash
ls /tmp/jobfinder/harness.*.json 2>/dev/null
```

Each file contains:

```json
{
  "url": "http://127.0.0.1:56580",
  "port": 56580,
  "pid": 12345,
  "screen": "http://127.0.0.1:56580/screen",
  "keys": "http://127.0.0.1:56580/keys"
}
```

- **No files** → no harness is running. Ask the user to start one in their terminal with `jobfinder tui --harness` (they see the live TUI; you drive it), or start one yourself in the background (e.g. `jobfinder tui --harness --harness-port 5599 &`) — headless is fine when stdout is not a terminal.
- **Exactly one file** → use its `screen` and `keys` URLs.
- **More than one file** → several TUIs are running. Do **not** guess. Read the `pid` from each file and **ask the user which instance to connect to** — every TUI shows its own `pid <n>` in the top-right corner of its screen, so the user can read it off the window they mean. Then use that file's `screen` / `keys` URLs.

If a request to a discovered instance fails, its process may have died uncleanly (a stale file); confirm it is alive with `kill -0 <pid>` and fall back to the other instances. (A new harness sweeps stale files on startup, but one can briefly linger.)

Read all instances and their pids at once, e.g.:

```bash
for f in /tmp/jobfinder/harness.*.json; do
  python3 -c "import json,sys; d=json.load(open('$f')); print(d['pid'], d['url'])"
done
```

Once you've picked an instance, set its endpoints from that file, e.g. for pid 12345:

```bash
SCREEN=$(python3 -c "import json;print(json.load(open('/tmp/jobfinder/harness.12345.json'))['screen'])")
KEYS=$(python3 -c "import json;print(json.load(open('/tmp/jobfinder/harness.12345.json'))['keys'])")
```

### 2. Read the current screen

`GET {screen}` returns a plain-text (ANSI-stripped) snapshot of the current frame:

```bash
curl -s "$SCREEN"
```

### 3. Send keystrokes

`POST {keys}` injects keys and returns the resulting frame. Body is JSON:

- `keys`: array of key tokens, applied in order with a re-render between each (so a batch behaves like real successive presses).
- `text`: a literal string, typed one character at a time.
- `settle`: optional ms to wait for the re-render after each key (default 60).

Key tokens are either named keys — `up`, `down`, `left`, `right`, `enter`, `escape`, `tab`, `pageup`, `pagedown`, `home`, `end`, `backspace`, `delete`, `space`, `ctrl+c` — or literal characters (`q`, `s`, `o`, `p`, `y`, …). `GET {url}/` lists the key names.

```bash
# Move down twice and open the highlighted row
curl -s "$KEYS" -d '{"keys":["down","down","enter"]}'

# Switch tabs and cycle the sort
curl -s "$KEYS" -d '{"keys":["right","s"]}'
```

The response body is the frame after the keys settle, so a single `POST /keys` both acts and reads. Read the returned screen to decide the next keys.

### 4. TUI key reference (what the keys do)

The footer of the dashboard lists them, but the common ones: arrows/`tab` switch tab or move the cursor, `enter` opens the highlighted Job/Source, `p` toggles pipeline focus, `s`/`S` cycle the sort, `o`/`O` change the scope filter, `t`/`T` tag/untag a job, `y` copies a deep-link command, `q` or `Esc` quits. Each TUI shows its own `pid <n>` in the top-right corner.

Sending `q` (or `Esc` from the top-level view) quits that TUI, which stops its server, removes its `/tmp/jobfinder/harness.<pid>.json`, and ends the process. Only do that when the user wants to close that dashboard.

---
name: job-finder
description: When user asks to use the cli (aka jobfinder) tool, or to drive/inspect the live TUI dashboard.
---

Read this file `__generated__/cli/help-menu.json` to understand the commands available in the cli tool. When user asks to use the cli tool, run the appropriate command and return the output to the user.

## Driving the live TUI dashboard (harness server)

When the user wants you to inspect or operate the live dashboard (the `jobfinder tui` view), use the harness control server. It runs the normal live TUI **and** exposes an HTTP API so you can read the screen and press keys on the same instance the user is watching.

### 1. Find (or start) a running harness

The harness publishes its connection info to `/tmp/jobfinder/harness.json` while it is running, and removes the file on exit. Read it first:

```bash
cat /tmp/jobfinder/harness.json
```

It contains:

```json
{
  "url": "http://127.0.0.1:56580",
  "port": 56580,
  "pid": 12345,
  "screen": "http://127.0.0.1:56580/screen",
  "keys": "http://127.0.0.1:56580/keys"
}
```

- If the file exists, a harness is running — use the `screen` and `keys` URLs from it. (If requests fail, the process may have died uncleanly; check `pid` with `kill -0 <pid>`.)
- If the file is absent, no harness is running. Ask the user to start one in their terminal with `jobfinder tui --harness` (they see the live TUI; you drive it), or start one yourself in the background (e.g. `jobfinder tui --harness --harness-port 5599 &`) — headless is fine when stdout is not a terminal.

### 2. Read the current screen

`GET {screen}` returns a plain-text (ANSI-stripped) snapshot of the current frame:

```bash
curl -s "$(python3 -c "import json;print(json.load(open('/tmp/jobfinder/harness.json'))['screen'])")"
```

### 3. Send keystrokes

`POST {keys}` injects keys and returns the resulting frame. Body is JSON:

- `keys`: array of key tokens, applied in order with a re-render between each (so a batch behaves like real successive presses).
- `text`: a literal string, typed one character at a time.
- `settle`: optional ms to wait for the re-render after each key (default 60).

Key tokens are either named keys — `up`, `down`, `left`, `right`, `enter`, `escape`, `tab`, `pageup`, `pagedown`, `home`, `end`, `backspace`, `delete`, `space`, `ctrl+c` — or literal characters (`q`, `s`, `o`, `p`, `y`, …). `GET {url}/` lists the key names.

```bash
KEYS=$(python3 -c "import json;print(json.load(open('/tmp/jobfinder/harness.json'))['keys'])")

# Move down twice and open the highlighted row
curl -s "$KEYS" -d '{"keys":["down","down","enter"]}'

# Switch tabs and cycle the sort
curl -s "$KEYS" -d '{"keys":["right","s"]}'
```

The response body is the frame after the keys settle, so a single `POST /keys` both acts and reads. Read the returned screen to decide the next keys.

### 4. TUI key reference (what the keys do)

The footer of the dashboard lists them, but the common ones: arrows/`tab` switch tab or move the cursor, `enter` opens the highlighted Job/Source, `p` toggles pipeline focus, `s`/`S` cycle the sort, `o`/`O` change the scope filter, `t`/`T` tag/untag a job, `y` copies a deep-link command, `q` or `Esc` quits.

Sending `q` (or `Esc` from the top-level view) quits the TUI, which stops the server, removes `/tmp/jobfinder/harness.json`, and ends the process. Only do that when the user wants to close the dashboard.

# Clawd Deck 🦞

A small local dashboard for people who run a lot of Claude Code sessions at once.

One page in your browser shows every session as a card: what it's working on, whether it's finished, whether it's stuck waiting for you, and how full its context window is. Click a card and you get the whole conversation as clean, copyable text. Sessions you start with the included launcher also get a live terminal right in the browser.

Everything runs on your own machine. The only network traffic is the GitHub queries the `gh` tool already makes for the PR panel.

## Why this exists

Ten or fifteen terminal tabs, all named "claude", all looking identical. No way to tell which one finished, which one is quietly blocked on a permission prompt, and which one is about to run out of context. And when you copy Claude's answer out of a terminal, it arrives full of wrapped lines, bullets, and indentation you have to clean up by hand.

The dashboard fixes all three. It watches every session, labels each one in plain language, waves at you when one actually needs you, and gives you Claude's text exactly as Claude wrote it.

## Quick start

```
cd ~/claude-deck
npm install
node setup-hooks.js
npm start
```

Then open [http://localhost:4839](http://localhost:4839). Sessions you already have open appear on their own, usually within a few seconds. Nothing needs restarting.

The `setup-hooks.js` step wires the dashboard's event hooks into your `~/.claude/settings.json`. It only appends what's missing, backs the file up first, and is safe to run again. The dashboard works without it (statuses come from polling), but hooks add instant updates, live to-do lists, and the needs-you notifications.

## Reading the board

Each card shows the session's title, the prompt that started it, its folder and git branch, a context meter, and its current to-do list. The status dot and badge tell you what matters:

- **Green, pulsing**: working. Leave it alone.
- **Blue READY**: it finished its turn and is waiting for you to read the result. This fades to plain idle after 30 minutes.
- **Amber NEEDS YOU**: it's blocked, usually on a permission prompt, and can't continue until you go click something.
- **Violet STARTING**: launched but not checked in yet. If it sits here, click the card — the live terminal shows what it's waiting on (a sign-in screen, a trust prompt) and you can answer right there.
- **Grey**: idle.

The counter in the header ("2 working, 3 ready, 1 needs you") and the browser tab title track the same thing, so you can park the dashboard on a second monitor and glance at it.

The header also has a light/dark toggle — the whole page switches, including the embedded terminals, which re-color in place. The "hide panel / show panel" button collapses the sidebar when you want the cards (or a session's terminal) at full width. On cards, the tinted `@ home` / `@ work` chip is the account the session runs under.

### Titles

Claude Code names most sessions after their folder plus two random characters, like `cortex-b0`, which tells you nothing. For those, the dashboard writes a short descriptive title from the session's first prompt. It uses one tiny background Claude call per session and caches the answer forever in `config.json`, so nothing gets renamed twice. Sessions with deliberate names are left alone. Hover a card and click the pencil to set your own title, which always wins. Hovering the title shows the real underlying session name in case you need it for `/resume`.

### The sidebar

Three tabs. **To-dos** gathers every session's task list in one place. **Artifacts** collects the files and published links each session has produced. **PRs** shows your open GitHub pull requests, split into ones you wrote and ones waiting on your review, with test status and review state on each row.

## Inside a session

Click any card. You get the full conversation, rendered as a readable document: your prompts, Claude's answers, working links, formatted code. Every message has a copy button, and so does every code block. What you copy is exactly what Claude wrote. No soft line wraps, no bullet symbols, no leading spaces.

If the session was started with `cc` (below), you also get a live terminal beside the conversation, and you can type into it from the browser. To scroll it, drag the **scrollbar** on the terminal's right edge — same motion as the conversation pane's scrollbar. It moves through the session's full history; drag to the bottom and you're back at the live prompt. A trackpad or wheel works too. The bar is always there while a terminal is connected — a full-length thumb means there's nothing to scroll yet (nothing has left the screen, or a full-screen view like a menu owns the screen until it's closed; the bar's tooltip says which). Keyboard arrow keys are claude's own prompt-history keys, not scrolling. One trade: with the mouse handed to tmux, select text by holding **Shift** while dragging — or just use the copy-paste view, which is the better copy surface anyway.

You can also link straight to a session: `http://localhost:4839/?session=<id>`.

## The cc launcher

Sessions started in a plain terminal tab can be watched but not typed into. That's a limit of how terminals work: the tab owns the session, and nothing else can plug into it.

The `cc` script gets around this by starting Claude inside tmux, which any screen can attach to. Your terminal tab attaches, and so can the dashboard. Same session, two windows.

```
cc golden-hour
```

That starts Claude with the display name `golden-hour` in a tmux session the dashboard can embed. Run `cc` with no name and it uses the current folder's name. Running the same name again reattaches instead of starting a duplicate.

A useful side effect: because tmux owns the session, closing the terminal tab doesn't kill it. The session keeps running, and `cc golden-hour` from any terminal picks it back up.

The **+ New session** button does the same thing from the browser: pick a folder (type a path or browse the folder tree in the dialog), name the session, pick an account, and the dashboard opens straight into the new session's live terminal. The dialog resizes from its bottom-right corner, and the small bar between the recent list and the folder list drags to portion the space between them — both are remembered.

To put `cc` on your PATH, add this to `~/.zshrc` and open a new terminal:

```
export PATH="$HOME/claude-deck/bin:$PATH"
```

## Multiple Claude accounts

Account profiles live in `profiles.json` in the project folder — a file that is yours to edit and that the server never writes, so your edits always stick. (They used to live in `config.json`, where the title cache overwrote hand edits; the server migrates old setups automatically.) The server watches the file, so changes apply within a few seconds, no restart needed:

```json
{
  "main": { "label": "home" },
  "profiles": [
    { "id": "work", "label": "work", "dir": "~/.claude-profiles/work" }
  ]
}
```

`main` is whatever `~/.claude` is logged into — the label is just what you want to call it. Each extra profile gets its own config directory, its own sessions, transcripts, and memory, an account chip on its cards, and an entry in the New session dialog's account picker.

The server seeds a new profile directory automatically, so the first session under it boots to Claude's sign-in screen instead of the first-run wizard — and since new sessions now open straight into their live terminal, that sign-in screen is something you can see and type into. Seeding also opts the profile out of Claude Code's fullscreen renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`), which is the default for newly created profiles and would otherwise leave the terminal with no scrollback; sessions in fullscreen mode anyway (someone ran `/tui fullscreen`) still scroll — the dashboard's scrollbar pages them instead.

One thing to understand about how Claude Code works on a Mac: interactive logins live in a single shared keychain entry, no matter which config directory a session uses. Running `/login` anywhere switches the account for every session that relies on that shared login. So the main profile's chip describes a shared login, not a per-session fact, and its tooltip says so.

To give a second profile its own account for real, use a long-lived token instead of the shared login:

1. Pick a quiet moment (the swap below briefly affects running sessions).
2. `/login` to the second account in any terminal, then run `claude setup-token` and copy the token it prints.
3. `/login` back to your usual account.
4. Save the token as a single line in the profile's directory, named `token`, and make it private:

```
chmod 600 ~/.claude-profiles/work/token
```

The dashboard reads that file and pins every session it starts under that profile to that account, independent of the keychain. The token grants access to the account, so treat the file like a password. From then on, both accounts run at the same time and every chip is truthful.

Wire a new profile's hooks the same way as the main ones: `node setup-hooks.js --dir ~/.claude-profiles/work`.

## Memory updates

The **update memory** button on each card starts a separate background Claude that reads that session's transcript and saves anything durable (preferences, decisions, project state) to that project's memory files. It reports a one-line summary on the card when it's done, and it never touches the live session. Each press costs one short Claude run.

The **auto-memory on session end** toggle in the header does the same automatically whenever any session ends. It's off by default because closing lots of short sessions would add up.

## Start at login (optional)

Save this as `~/Library/LaunchAgents/cc.claude-deck.plist`, adjust the two paths if your setup differs, then run `launchctl load ~/Library/LaunchAgents/cc.claude-deck.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>cc.claude-deck</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/Users/karenspinner/claude-deck/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/karenspinner/claude-deck</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/tmp/claude-deck.log</string>
</dict>
</plist>
```

## How it works

Three data sources, most reliable first:

1. `claude agents --json`, a supported Claude Code command that lists live sessions with their names and statuses. The server polls it every few seconds.
2. Claude Code hooks. A one-line shell script POSTs each session event (prompt sent, turn finished, permission needed, to-dos changed) to the server. If the server is down, the script gives up after one second and the session never notices.
3. The transcript files Claude Code writes to disk. These power the context meter, the conversation view, and the artifacts list. Their format is officially undocumented and can change between Claude Code releases, so the parsers fail soft: if a field disappears someday, that feature greys out instead of taking the dashboard down.

The pieces: `server.js` (Node, no build step), `public/` (plain HTML, CSS, and JavaScript, with xterm.js for the embedded terminal), `hooks/emit.sh` (the hook script, registered in `~/.claude/settings.json`), and `bin/cc` (the launcher). Setup needs `node`, `tmux` (only for embedded terminals), and `gh` logged in (only for the PR panel).

## When something looks off

- **The terminal pane says "posix_spawnp failed".** A helper binary inside node-pty lost its execute permission, which happens on reinstall. Run `npm run postinstall` in the project folder to fix it.
- **The context meter or conversation goes blank after a Claude Code update.** The transcript format probably changed. The dashboard keeps running; the parsers in `server.js` (`refreshTranscriptTails` and `parseConversation`) are where to adapt.
- **The PR tab shows an error.** Run `gh auth status` and, if needed, `gh auth login`.
- **The port is taken.** Something else is on 4839. `kill $(lsof -ti :4839)` and start again.
- **A badge looks wrong.** The server logs every notification it receives to `/tmp/claude-deck.log` with its type and message, so you can see exactly what Claude Code sent and adjust the classifier in `server.js`.

## Taking it apart

Stop the server, remove the claude-deck hook entries from `~/.claude/settings.json`, delete the project folder, and remove the LaunchAgent if you installed it. `brew uninstall tmux` if nothing else uses it.

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
npm start
```

Then open [http://localhost:4839](http://localhost:4839). Sessions you already have open appear on their own, usually within a few seconds. Nothing needs restarting.

## Reading the board

Each card shows the session's title, the prompt that started it, its folder and git branch, a context meter, and its current to-do list. The status dot and badge tell you what matters:

- **Green, pulsing**: working. Leave it alone.
- **Blue READY**: it finished its turn and is waiting for you to read the result. This fades to plain idle after 30 minutes.
- **Amber NEEDS YOU**: it's blocked, usually on a permission prompt, and can't continue until you go click something.
- **Grey**: idle.

The counter in the header ("2 working, 3 ready, 1 needs you") and the browser tab title track the same thing, so you can park the dashboard on a second monitor and glance at it.

### Titles

Claude Code names most sessions after their folder plus two random characters, like `cortex-b0`, which tells you nothing. For those, the dashboard writes a short descriptive title from the session's first prompt. It uses one tiny background Claude call per session and caches the answer forever in `config.json`, so nothing gets renamed twice. Sessions with deliberate names are left alone. Hover a card and click the pencil to set your own title, which always wins. Hovering the title shows the real underlying session name in case you need it for `/resume`.

### The sidebar

Three tabs. **To-dos** gathers every session's task list in one place. **Artifacts** collects the files and published links each session has produced. **PRs** shows your open GitHub pull requests, split into ones you wrote and ones waiting on your review, with test status and review state on each row.

## Inside a session

Click any card. You get the full conversation, rendered as a readable document: your prompts, Claude's answers, working links, formatted code. Every message has a copy button, and so does every code block. What you copy is exactly what Claude wrote. No soft line wraps, no bullet symbols, no leading spaces.

If the session was started with `cc` (below), you also get a live terminal beside the conversation, and you can type into it from the browser.

You can also link straight to a session: `http://localhost:4839/?session=<id>`.

## The cc launcher

Sessions started in a plain terminal tab can be watched but not typed into. That's a limit of how terminals work: the tab owns the session, and nothing else can plug into it.

The `cc` script gets around this by starting Claude inside tmux, which any screen can attach to. Your terminal tab attaches, and so can the dashboard. Same session, two windows.

```
cc golden-hour
```

That starts Claude with the display name `golden-hour` in a tmux session the dashboard can embed. Run `cc` with no name and it uses the current folder's name. Running the same name again reattaches instead of starting a duplicate.

A useful side effect: because tmux owns the session, closing the terminal tab doesn't kill it. The session keeps running, and `cc golden-hour` from any terminal picks it back up.

To put `cc` on your PATH, add this to `~/.zshrc` and open a new terminal:

```
export PATH="$HOME/claude-deck/bin:$PATH"
```

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

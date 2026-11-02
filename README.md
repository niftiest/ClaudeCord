# ClaudeCord

**All your Claude Code chats, in one friendly app.**

ClaudeCord gives Claude Code a home that looks and feels like Discord. Every project you've worked on becomes a channel,
every conversation is there to scroll back through, and you can keep chatting with Claude without opening a terminal.

## What you can do

### Find anything, fast
- **Every project in one list.** Projects show up on their own, sorted into Today, Yesterday, This week and so on, with
  the latest message right under each name.
- **Organise it your way.** Star favourites, sort projects into your own groups, rename them, give them icons or
  pictures, and hide the ones you don't need.
- **Search everything.** Press Ctrl+K to search every conversation you've ever had.
- **Never miss a reply.** Projects with new activity are highlighted, and day dividers make long chats easy to follow.

### Chat comfortably
- **Pick up any conversation** right where you left off, or start a new one in any folder.
- **Choose how Claude works** for each chat: which model, how hard it should think, and whether it needs to ask
  before making changes.
- **Watch it work.** Replies appear as Claude writes them, along with what it's doing: commands it runs, files it reads
  and changes, and its thinking.
- **Keep the ideas coming.** Type your next messages while Claude is still busy and they'll wait in line. Press Esc to
  stop Claude or pull a waiting message back to edit.
- **Share screenshots.** Paste or drop images straight into the message box.
- **Stay in control.** When Claude asks for permission or wants to run a plan past you, approve or decline with a
  click. If another chat is waiting on you, a banner tells you which one.
- **Know what it costs.** See the running cost of each chat and of everything together, and set a spending cap.
- **Get a nudge when it's your turn.** A desktop notification tells you when Claude finishes, needs permission or has
  a question, with Do not disturb and quiet hours. ClaudeCord can also live in the system tray.
- **See your project's files** alongside the chat, with changed files marked.

### Works alongside the terminal
- **Use both.** Keep using Claude in a terminal whenever you like. ClaudeCord notices, moves that chat to the top, and
  shows the new messages as they arrive.
- **No mix-ups.** While a chat is open in a terminal, ClaudeCord makes it read-only, so two windows never talk over
  each other. It unlocks by itself when the terminal closes.
- **Know what's reachable.** Chats you've opened for remote control from your phone or the web get a small badge.
- **See what's running.** A panel lists every Claude process ClaudeCord has open and lets you stop one.

### Clean up and look after your history
Claude Code quietly keeps a lot of data over time. ClaudeCord's **Manage** screen shows you all of it and lets you tidy
up safely.
- **See where the space goes.** Every project with its size, how many chats it has and when you last used it, plus a
  search that looks through names, chats and Claude's memory.
- **Delete a chat or a whole project, safely.** A step-by-step guide closes anything still using it, offers to save a
  backup first, shows exactly what will be removed and sends it to the Recycle Bin. Your actual project files are never
  touched.
- **Back up and restore.** Save projects to a backup file and bring them back any time. Backups made before a delete
  are kept so you can undo it.
- **Move or rename a project folder** without losing its chats, memory or settings.
- **Search your notes.** Find the notes, plans and docs inside your projects, preview them and open them in your editor.
- **Close Claude sessions** that are still running, all from one place.
- **Keep your chats as long as you like.** Claude Code deletes chats after 30 days unless you change it. ClaudeCord
  shows you that setting, warns you if a project shortens it, and lets you change it with a click.
- **Tidy up automatically, per project.** Have old chats in some projects move to the Recycle Bin after a while
  while others are kept forever.

### Make it yours
- **Two looks.** A Discord-style look, or a classic terminal look for just the chat window or the whole app.
- **Claude's avatar.** Pick an emoji, a colour or a picture, or create one with AI using your own image-service key.
- **Create images** for a project with AI and save them straight into its folder (optional, uses your own key).
- **Commands and files as you type.** `/` lists every skill and command Claude has for that project, including plugins, and real ones are highlighted. `@` finds project files to mention. `/compact`, `/context`, `/usage` and other commands work right in the chat, and `/clear` starts a new chat in the same folder.
- **See your setup.** Browse the skills and commands Claude has available, and check how each of your tools (MCP servers) is doing, without digging through files.
- **Take a chat back from a terminal.** When a chat is locked because a terminal has it open, "Hijack conversation" closes Claude in that terminal and unlocks the chat here. It only works while Claude is waiting for you, never in the middle of work.
- **See what Claude is doing, without the noise.** A live line shows how long it's been working, tokens used and the current tool. Tool calls collapse into one line you can expand, or you can show them all or hide them.
- **Your model list, and how full a chat is.** Model pickers come straight from Claude Code, a context bar shows how much room a chat has left with a Compact button when it fills up, and each project remembers its model, effort and permissions.
- **Optional next-prompt suggestions.** Claude can predict your next message as a chip you click to fill the box. Off by default, for everything or project by project.
- **Edit what Claude remembers.** Right-click a project to open its folder, or to view and edit its `CLAUDE.md` and Claude's auto-memory notes. Running chats pick up changes on their next message.
- **Replies that look right.** Tables, bold, bullets, headings, links and code blocks are formatted properly, with syntax colours and a copy button on code. Images show as thumbnails that open larger when clicked.
- **Run shell commands from a chat.** Start a message with `!` to run a command in the chat's folder, without Claude and without using tokens. Claude sees the output with your next message, or you can leave it out.
- **Start from GitHub.** If the GitHub CLI (`gh`) is installed and signed in, projects linked to a GitHub repo show a GitHub icon, and New chat lists your repositories that don't have a project yet. Pick one and ClaudeCord clones it (or pulls it, if it's already in that folder), then starts the chat with the settings you chose.
- **Know what you're opening.** Before a new chat starts in a folder Claude has never worked in, ClaudeCord asks whether you trust it and names the hooks, MCP servers and settings it would pick up.
- **Know when a tool is down.** If a chat's MCP server fails or needs a sign-in, a warning appears in the header, with the reason and a Reconnect or Sign in button.
- **Claude Code's settings, without the files.** Choose Claude's default model and effort, what it may do without
  asking, whether commits credit Claude, memory and more, for all projects or just one. Changes apply in the
  terminal too.
- **Start with Windows** if you like, and ClaudeCord keeps itself up to date.

## Getting started

1. Make sure [Claude Code](https://docs.claude.com/en/docs/claude-code) is installed and you're signed in.
2. Download ClaudeCord from the [Releases page](https://github.com/niftiest/ClaudeCord/releases):
   - **ClaudeCord-Setup**: installs ClaudeCord and keeps it up to date automatically.
   - **ClaudeCord-Portable**: a single file you can run from anywhere, nothing to install. It tells you when a new
     version is out.
3. Open it. Your projects and chats appear on their own.

ClaudeCord runs on Windows 10 and 11.

> Windows may show a "Windows protected your PC" message the first time, because ClaudeCord isn't signed with a
> certificate yet. Click **More info**, then **Run anyway**.

## Your data stays yours

ClaudeCord runs entirely on your computer. There's no account, no tracking and no server. It only goes online to check
for new versions of itself, and to an image service if you choose to use the optional AI image features with your own
key.

## For developers

ClaudeCord is open source. To run it from source you'll need Node.js 22 or newer:

```
npm install
npm run dev
```

## License

[MIT](LICENSE)

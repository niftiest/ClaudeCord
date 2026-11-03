# ClaudeCord shows no projects for someone who uses Claude through claude.ai or the desktop app

## What happened

A Windows user installed ClaudeCord expecting to see their Claude projects and chats. The sidebar
stayed empty apart from "No projects indexed yet.", with no hint as to why.

## Cause

ClaudeCord only reads **Claude Code CLI** history: `discover()` walks `%USERPROFILE%\.claude\projects`
(or `CLAUDE_CONFIG_DIR`). This user had never installed the CLI, so that folder didn't exist.
`discover()` correctly returned `[]`, and the catalog stayed empty.

Their chats and projects lived in their claude.ai account (web and desktop app). None of that is
stored on disk in a form ClaudeCord can read, so no change to the scanner would have found it.

The indexing, discovery and live-session code was reviewed and looks correct. This is not a scanner
bug. The problems below are about what the app tells the user, and about getting set up.

## Issues

### 1. The empty state doesn't explain itself

`Nav.tsx` shows "No projects indexed yet." whether the user has zero chats or has never installed
Claude Code. Someone who isn't a CLI user can't tell which.

**Suggested fix:** when the projects root is missing, or the `claude` binary can't be found, show a
specific message instead. For example: "No Claude Code chats found. ClaudeCord shows chats from the
Claude Code CLI. Chats on claude.ai or in the Claude desktop app aren't stored on this PC." Add a
link to the install docs (https://code.claude.com/docs/en/setup) and a "Scan again" button.

### 2. The CLI can be installed but not on PATH

On this machine, the native Windows installer (`irm https://claude.ai/install.ps1 | iex`) put
`claude.exe` in `%USERPROFILE%\.local\bin` but warned that the folder wasn't on PATH. The default
`claudeBin` setting is `'claude'`, which is found through PATH, so ClaudeCord couldn't start chats
until the user fixed PATH by hand. ClaudeCord also had to be fully restarted, including from the
tray, to pick up the new PATH.

**Suggested fix:** when `claudeBin` is the default and spawning it fails with `ENOENT`, fall back to
`%USERPROFILE%\.local\bin\claude.exe` if it exists. Then show a clear "Claude Code isn't installed
or isn't on PATH" message rather than a generic spawn error.

### 3. Feature request: import a claude.ai data export

People who mostly use claude.ai can download their history from Settings → Privacy → Export data.
ClaudeCord could offer "Import claude.ai export…", which reads that file and shows the
conversations as **read-only** channels. They would stay separate from Claude Code chats and could
not be resumed by the CLI. The export format has not been checked yet, so this would start with a
look at a real export file.

## How this was confirmed

- No `.claude` folder in the user's home directory.
- ClaudeCord's `catalog.db` on that machine was essentially empty.
- The user has since installed the CLI and added `%USERPROFILE%\.local\bin` to PATH. Once they sign
  in and start a chat, ClaudeCord should index it. That part hasn't been confirmed yet.

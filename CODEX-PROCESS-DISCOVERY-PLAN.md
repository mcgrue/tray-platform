# Codex process discovery

First step of the remote messaging project: maintain an in-memory inventory of local
Codex processes descended from VS Code, and display it directly below Attention Inbox.

- Scan at application startup and every five minutes; allow manual refresh.
- Use a Windows process snapshot to establish ancestry and process start times.
- Use VS Code diagnostics to associate extension hosts with window titles. Read the
  matching extension-host workspace metadata for folder/workspace paths when available.
- Show the owning VS Code extension-host PID and Codex PID. Retain the main-process
  and window-renderer PIDs in the inventory for subsequent integration work.
- Publish snapshots through Electron IPC and a loopback-only read API.
- Replace the inventory on successful scans; preserve and label the last result on
  scan failure. Do not overlap scans; stop timers and helpers on shutdown.
- Validate with new discovery/lifecycle tests and a real Electron UI smoke. Preserve
  existing tests and unrelated worktree edits.

# HUMAN QUESTIONS

None required for this step. Folder discovery is best effort and missing metadata
will be displayed explicitly. Remote messaging and Tailscale integration are later steps.

## Validation

- Build passed; 14 new discovery, lifecycle, and API checks passed.
- Full suite: 150/151 passed; the existing concurrent attention-answer hook test
  hit a transient Windows EPERM and passed when rerun (12/12 in that suite).
- Real Electron smoke found 14 Codex instances, all with window titles and full
  folder paths. Verified IPC/API, placement, manual refresh, reload, empty/error
  states, text escaping, and disposal; visually inspected the rendered table.
- Repeated the smoke with deliberately closed stdout/stderr pipes: exit code 0,
  durable JSON report written, and no remaining smoke process. The smoke now
  handles EPIPE rather than opening an Electron main-process error dialog.

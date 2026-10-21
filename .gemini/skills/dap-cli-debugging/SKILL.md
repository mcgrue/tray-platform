---
name: dap-cli-debugging
description: Control the VS Code Debugger (DAP) via CLI commands using mcp-debug-tools. Use when debugging, setting breakpoints, stepping through code, or inspecting variables.
---

# AI Agent Skill: VS Code DAP Debugger Control via CLI

## Objective
You (the AI Agent) can directly control the VS Code **Debugger (DAP)** via terminal CLI commands.
No stdio connection needed — use one-off CLI commands to control the full debug lifecycle.

## CLI Interface

All commands use: `npx @uhd_kr/mcp-debug-tools <command> [args]`

### Local Path Fallback (When npx is unavailable)

If `npx` is unavailable (e.g., offline, network restrictions), you can run the CLI directly from the VS Code extension's install directory.

**macOS / Linux:**
```bash
node ~/.vscode/extensions/uhd.mcp-debug-tools-*/out/cli.js <command> [args]
```

**Windows (PowerShell):**
```powershell
node "$env:USERPROFILE\.vscode\extensions\uhd.mcp-debug-tools-*\out\cli.js" <command> [args]
```

**Windows (CMD):**
```cmd
node "%USERPROFILE%\.vscode\extensions\uhd.mcp-debug-tools-*\out\cli.js" <command> [args]
```

> **Tip**: If you installed mcp-debug-tools globally via `npm install -g @uhd_kr/mcp-debug-tools`, you can simply run `mcp-debug-tools <command>` directly without `npx`.

**Key Rules:**
- `stdout` = pure JSON result. **Always parse stdout only.**
- `stderr` = connection logs. **Ignore stderr.**
- On error, read the JSON error message, correct arguments, and retry.

### Commands

| Command | Usage |
|---------|-------|
| **list** | `npx mcp-debug-tools list` — Discover all available tools and their input schemas |
| **call** | `npx mcp-debug-tools call <toolName> [jsonArgs]` — Execute a specific tool |
| **read** | `npx mcp-debug-tools read <resourceUri>` — Read a debugger state resource |

## Available Tools — Quick Reference

### Session & Config Management
| Tool | Params | Description |
|------|--------|-------------|
| `get-active-session` | — | Check if debugger is running, get session info |
| `get-debug-state` | — | Get full debug state: session + all breakpoints |
| `list-debug-configs` | — | List all configurations from launch.json |
| `select-debug-config` | `configName` | Select a specific debug configuration by name |
| `start-debug` | `config` (name from launch.json) | Start a debug session |
| `stop-debug` | — | Stop the active debug session |
| `get-workspace-info` | — | Get current workspace information |
| `list-vscode-instances` | — | List all active VS Code instances |
| `select-vscode-instance` | `port?`, `workspace?` | Connect to a specific VS Code instance |

### Breakpoint Management
| Tool | Params | Description |
|------|--------|-------------|
| `add-breakpoint` | `file`, `line`, `condition?`, `hitCondition?`, `logMessage?` | Add a single breakpoint |
| `add-breakpoints` | `breakpoints[]` (array of above) | Add multiple breakpoints at once |
| `remove-breakpoint` | `file`, `line` | Remove a breakpoint at specific location |
| `clear-breakpoints` | `files?[]` | Remove all breakpoints (or from specific files) |
| `list-breakpoints` | — | List all breakpoints (basic) |
| `get-breakpoints` | — | Get detailed breakpoint info including conditions |

### Execution Control
| Tool | Params | Description |
|------|--------|-------------|
| `continue` | — | Resume execution |
| `step-over` | — | Step over current line |
| `step-into` | — | Step into function call |
| `step-out` | — | Step out of current function |
| `pause` | — | Pause running execution |

### State Inspection
| Tool | Params | Description |
|------|--------|-------------|
| `get-call-stack` | `threadId?`, `startFrame?`, `levels?` | Get call stack frames |
| `get-active-stack-item` | — | Get the currently active stack frame |
| `get-variables-scope` | `frameId?`, `scopeName?` | Get all variables in scope |
| `inspect-variable` | `variableName` | Get detailed info about a specific variable |
| `evaluate-expression` | `expression` | Evaluate an expression in debug context |
| `get-thread-list` | — | List all threads |
| `get-exception-info` | `limit?`, `includeStackTrace?` | Get recent exception details |
| `get-debug-console` | `limit?`, `filter?` | Retrieve debug console output |
| `get-dap-log` | — | Get raw DAP protocol messages |

## CLI Examples

```bash
# Check debugger status
npx mcp-debug-tools call get-active-session

# Set a conditional breakpoint
npx mcp-debug-tools call add-breakpoint '{"file": "src/app.ts", "line": 15, "condition": "x > 10"}'

# Set multiple breakpoints at once
npx mcp-debug-tools call add-breakpoints '{"breakpoints": [{"file": "src/app.ts", "line": 10}, {"file": "src/app.ts", "line": 20}]}'

# Start debugging with a named config
npx mcp-debug-tools call start-debug '{"config": "Launch Program"}'

# Step and inspect
npx mcp-debug-tools call step-over
npx mcp-debug-tools call get-variables-scope
npx mcp-debug-tools call inspect-variable '{"variableName": "result"}'

# Evaluate an expression at current breakpoint
npx mcp-debug-tools call evaluate-expression '{"expression": "arr.length"}'

# Read resources directly
npx mcp-debug-tools read "dap://log"
```

## Standard Debugging Workflow

1. **Check Status** → `get-active-session`
2. **List Configs** → `list-debug-configs` (find the right launch config)
3. **Set Breakpoints** → `add-breakpoint` or `add-breakpoints`
4. **Start Debug** → `start-debug` with the config name
5. **Analyze State** → `get-call-stack` + `get-variables-scope`
6. **Inspect Details** → `inspect-variable` or `evaluate-expression`
7. **Step Through** → `step-over` / `step-into` / `step-out`, repeat 5-6
8. **Fix Code** → Edit source, then restart debugger to verify
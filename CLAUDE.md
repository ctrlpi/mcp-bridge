# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

An MCP (Model Context Protocol) server that controls one or more GPIO agents (`pi-gpio-api` Pis or `pico-gpio-api` Pico Ws) by calling their REST API over HTTP.

It acts strictly as an API proxy. Every tool targets an agent by name (from `config.json`) and proxies the call to that agent's REST endpoints (`/gpio/*`, `/config/*`, `/logs`, `/restart`), forwarding the agent's own `Api-Key`.

Implemented in Node.js (`server.js`) with **zero external dependencies**. The MCP protocol (JSON-RPC 2.0 over stdio / Streamable HTTP) is implemented directly using Node built-ins.

## Configuration

Everything lives in **`~/.ctrlpi/`**:

| File | Owner | Contents |
|---|---|---|
| `~/.ctrlpi/config.json` | shared | `agents[]` - `{name, ip, port, api_key}` per agent. Read by all ctrlpi projects, updatable by any. |
| `~/.ctrlpi/mcp-config.json` | this server | `mcp` (its own HTTP-mode `api_key`, `ip`, `port`) and `agents` whitelist/blacklist. |

**`--config <folder>`** overrides the directory for both files.

### Agent whitelist/blacklist

The shared `config.json` defines agents. `mcp-config.json` may filter this list:

```json
{ "agents": { "whitelist": ["pi5", "z2w"], "blacklist": ["z2w"] } }
```

Tools only see agents that survive the filter. `mcp_agents_list` won't list others, preventing access.

## Setup & Running

Requires Node.js 20+ (uses the built-in `fetch`). No dependencies — nothing to install.

```bash
node server.js             # stdio MCP server (default)
node server.js --http      # Streamable HTTP at /mcp, bound to 0.0.0.0 (all interfaces), default port 8315
node server.js --http --local  # bound to loopback only (127.0.0.1)
node server.js --http --host 0.0.0.0 --port 8315
```

### Flags

| Flag | Applies to | Effect |
|---|---|---|
| _(none)_ | — | Runs the stdio MCP server. |
| `--http` | transport | Runs Streamable HTTP transport at `POST /mcp` instead of stdio. |
| `--local` | `--http` | Restricts HTTP bind to loopback (`127.0.0.1`). |
| `--host <ip>` | `--http` | Explicit bind address. |
| `--port <n>` | `--http` | HTTP listen port (default `8315`). |
| `--no-scan` | setup | Disables the LAN sweep, at startup or on the timer. |
| `--rotate-keys` | setup | Re-keys an agent still on the shipped default key. |
| `--config <folder>` | config | Keep config files in this folder instead of `~/.ctrlpi/`. |

HTTP mode requires `Api-Key` header matching `mcp.api_key` from `mcp-config.json`. Stdio mode needs no auth.

## Architecture

Everything lives in **`server.js`**:

1. **Setup / agent discovery** — `sweep()` runs at startup and hourly. `scanForAgents()` sweeps the local /24 for an unauthenticated `/hello`. If the agent uses the default key, `--rotate-keys` updates it with a random one; otherwise, it is stored using the default key. Discovered agents are merged into `config.json` without overwriting existing entries. Setup runs non-interactively.
2. **Config / agent lookup** — `loadConfig()` re-reads `config.json` on every access.
3. **`callAgent()`** — The single HTTP proxy helper. Resolves the named agent, sends requests with the agent's `Api-Key`.
4. **MCP tools** — The `TOOLS` array defines `mcp_gpio_read`, `mcp_gpio_write`, `mcp_agents_list`, `mcp_sensor_config`, and `mcp_sensor_read`.
5. **`dispatch(msg)`** — The JSON-RPC core. Handles `initialize`, `ping`, `tools/list`, and `tools/call`. Unknown methods return `-32601`.
6. **Transports** — `runStdio()` reads newline-delimited JSON on stdin. `runHttp()` runs `http.createServer()` for POST `/mcp`.
7. **`main()`** — Runs HTTP or Stdio transport based on arguments.

## Agent discovery & reconciliation

Discovery handles three jobs:

| Job | When | What it does |
|---|---|---|
| **reconcile** | 1st | Repairs `ip` for agents that moved on the network (e.g., new DHCP lease). Adds nothing. |
| **rotate** | 2nd | Re-keys an agent still on the shipped default key (`--rotate-keys` only). |
| **search** | 3rd | Adds agents not on file. Runs after reconcile. |

An agent's stored key only goes on the wire to a new address once the old address is confirmed dead. Adopting a moved agent tries the default key first.
Timer (`sweep()`) repeats hourly to pick up agents switched on later.

**Trust on first use (HTTP key):** `adoptHttpKey()` takes the first different key any caller presents when `mcp.api_key` is still the default `your-mcp-key`, sets it in `mcp-config.json`, and accepts only it afterwards.

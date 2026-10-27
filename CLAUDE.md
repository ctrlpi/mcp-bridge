# CLAUDE.md - mcp-bridge

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The README is locked

`README.md` is done. Do not edit it without the user's explicit confirmation, even for a small wording or formatting fix, and even to keep it in sync with another project's README.

## What This Is

An MCP (Model Context Protocol) server that controls one or more GPIO agents (`pi-gpio-api` Pis, `pico-gpio-api` Pico Ws or `esp32-gpio-api` ESP32s) by calling their REST API over HTTP.

It acts strictly as an API proxy. Every tool targets an agent by name (from `agents-config.json`) and proxies the call to that agent's REST endpoints (`/gpio/*`, `/sensor/*`, `/script/*`, `/config/*`, `/logs`, `/restart`, `/upgrade`), forwarding the agent's own `Api-Key`.

Implemented in Node.js (`server.js`) with **zero external dependencies**. The MCP protocol (JSON-RPC 2.0 over stdio / Streamable HTTP) is implemented directly using Node built-ins.

## Configuration

Everything lives in **`~/.ctrlpi/`**:

| File | Owner | Contents |
|---|---|---|
| `~/.ctrlpi/agents-config.json` | shared | `agents[]` - `{name, ip, port, api_key, updated_at}` per agent. Read by all ctrlpi projects, updatable by any. |
| `~/.ctrlpi/mcp-config.json` | this server | `mcp` (its own HTTP-mode `api_key`, `ip`, `port`) and `agents` whitelist/blacklist. |

When reading `agents-config.json`, `mcp-bridge` also checks if `/var/lib/homebridge/ctrlpi-agents-config.json` exists; if so, it reads it (read-only) and reconciles agents whose `updated_at` date/time is newer. It never writes to the Homebridge path.

**`--config <folder>`** overrides the directory for both files.

### Agent whitelist/blacklist

The shared `agents-config.json` defines agents. `mcp-config.json` may filter this list:

```json
{ "agents": { "whitelist": ["pi5", "z2w"], "blacklist": ["z2w"] } }
```

Tools only see agents that survive the filter. `mcp_agents_list` won't list others, preventing access.

## Setup & Running

Requires Node.js 20+ (uses the built-in `fetch`). No dependencies, nothing to install.

```bash
npm start                          # stdio MCP server (default)
npm start -- --http                # Streamable HTTP at /mcp, bound to 0.0.0.0 (all interfaces), default port 8315
npm start -- --http --local        # bound to loopback only (127.0.0.1)
npm start -- --http --host 0.0.0.0 --port 8315
```

A flag without a valid value (`--port`, `--host`, `--rescan`, `--config`) exits with code 2 and a message (`flagValue()` / `intFlag()`).

### Flags

| Flag | Applies to | Effect |
|---|---|---|
| _(none)_ | - | Runs the stdio MCP server. |
| `--http` | transport | Runs Streamable HTTP transport at `POST /mcp` instead of stdio. |
| `--local` | `--http` | Restricts HTTP bind to loopback (`127.0.0.1`). |
| `--host <ip>` | `--http` | Explicit bind address. |
| `--port <n>` | `--http` | HTTP listen port (default `8315`). |
| `--no-scan` | setup | Disables the automatic LAN sweeps (startup and hourly). A first run with no `agents-config.json` still sweeps once; `mcp_agents_list(rescan=true)` still sweeps. |
| `--rescan <n>` | setup | Minutes between automatic sweeps (default 60); `0` turns them off like `--no-scan`. |
| `--rotate-keys` | setup | Re-keys an agent still on the shipped default key. |
| `--config <folder>` | config | Keep config files in this folder instead of `~/.ctrlpi/`. |

HTTP mode requires `Api-Key` header matching `mcp.api_key` from `mcp-config.json`. Stdio mode needs no auth. Only `/mcp` (or `/mcp/`) is served; a request carrying an `Origin` header is accepted only from a `localhost` or IP-address origin (`originAllowed()`, against DNS rebinding).

## Architecture

Everything lives in **`server.js`**:

1. **Agent discovery** - `sweep()` starts at launch and repeats hourly, in the background: the transport answers at once, `callAgent()` waits for a running sweep when it can't find the agent, and `mcp_agents_list` waits for one before listing. Concurrent callers share one sweep (`sweepPromise`). `scanForAgents()` probes the local /24 for an unauthenticated `/hello`, plus `127.0.0.1:9314-9319` for the mock agents used in self-testing. A new agent still on the default key keeps it, or gets a random one with `--rotate-keys`; one that refuses the default key is stored with an empty `api_key` for the user to fill in. Discovered agents are merged into `agents-config.json` without overwriting existing entries. Setup runs non-interactively.
2. **Config / agent lookup** - `loadConfig()` re-reads `agents-config.json` on every access. Agent names match case-insensitively (`sameName()`). When `mcp_config_write` or `mcp_config_load` changes an agent's `name` or `api_key`, `syncAgentEntry()` records it in `agents-config.json` (after any running sweep, so the sweep can't save over it).
3. **`callAgent()`** - The single HTTP proxy helper. Resolves the named agent, sends requests with the agent's `Api-Key`.
4. **MCP tools** - The `TOOLS` array defines 18 tools: `mcp_agents_list`, `mcp_gpio_read`, `mcp_gpio_write`, `mcp_gpio_scan`, `mcp_gpio_config`, `mcp_gpio_watched`, `mcp_sensor_config`, `mcp_sensor_read`, `mcp_script_list`, `mcp_script_read`, `mcp_script_write`, `mcp_script_run`, `mcp_config_read`, `mcp_config_write`, `mcp_config_load`, `mcp_agent_restart`, `mcp_agent_upgrade`, `mcp_agent_logs`.
5. **`dispatch(msg)`** - The JSON-RPC core. Handles `initialize`, `ping`, `tools/list`, and `tools/call`. Unknown methods return `-32601`.
6. **Transports** - `runStdio()` reads newline-delimited JSON on stdin and, when stdin closes, finishes the requests already read before exiting. `runHttp()` runs `http.createServer()` for POST `/mcp`.
7. **`main()`** - Starts the background sweep and timer, then the HTTP or stdio transport.

## Agent discovery & reconciliation

Discovery handles three jobs:

| Job | When | What it does |
|---|---|---|
| **reconcile** | 1st | Repairs `ip` for agents that moved on the network (e.g., new DHCP lease). Adds nothing. |
| **rotate** | 2nd | Re-keys an agent still on the shipped default key (`--rotate-keys` only). |
| **search** | 3rd | Adds agents not on file. Runs after reconcile. |

An agent's stored key only goes on the wire to a new address once the old address is confirmed dead. Adopting a moved agent tries the default key first.
The timer repeats `sweep()` hourly (`--rescan <n>`) to pick up agents switched on later.

**Trust on first use (HTTP key):** `adoptHttpKey()` takes the first different key any caller presents when `mcp.api_key` is still the default `your-mcp-key`, sets it in `mcp-config.json`, and accepts only it afterwards.

## Tests

`npm test` runs `test/mcp-bridge.test.js` against `mock_agent.py` (Python 3). The discovery tests set `MCP_BRIDGE_SCAN_LAN=0`, which limits a sweep to the localhost mock agents on 9314-9319, so they never probe the real /24 (on a Mac or on CI). Tool errors come back with `isError: true` (`toolResult()`). Keys, names, URLs and scripts in tool arguments are sent as text (`asText()` / `textFields()`), so an AI that passes `api_key: 4242` sets `"4242"`.

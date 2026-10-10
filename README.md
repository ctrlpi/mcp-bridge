# ctrlPi MCP Bridge

[![Platform: Cross-Platform](https://img.shields.io/badge/platform-Cross--Platform-006400.svg)](#requirements)
[![Version 0.9.24](https://img.shields.io/badge/version-0.9.24-blue.svg)](https://github.com/ctrlpi/mcp-bridge/tags)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](https://nodejs.org/)
[![Auth: Api-Key](https://img.shields.io/badge/auth-Api--Key-orange.svg)](#authentication)
[![Agents: Pi & Pico](https://img.shields.io/badge/agents-Pi%20%26%20Pico-006400.svg)](#requirements)
[![Protocol: MCP](https://img.shields.io/badge/protocol-MCP-006400.svg)](#tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-188038.svg)](LICENSE)
![Status: Beta](https://img.shields.io/badge/status-Beta-red.svg)
[![Build Status](https://github.com/ctrlpi/mcp-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/ctrlpi/mcp-bridge/actions)

An MCP (Model Context Protocol) server that lets an AI agent (e.g. Claude Desktop) control one or more GPIO agents through an ordinary conversation, by calling their REST API over HTTP.

Runs on a Mac, a Raspberry Pi, or any Linux box, secured with API key authentication, zero npm dependencies.

> Looking for the GPIO servers themselves, or Apple HomeKit and Google Home? See the [Related projects](#related-projects) below.

This app acts as a pure API proxy. It is a thin MCP front-end: every tool targets an agent and proxies the request to that agent's REST endpoints, forwarding that agent's own `Api-Key`.

```
[MCP client: Claude Desktop / mcp-remote]
        │  MCP (STDIO or Streamable HTTP /mcp)
        ▼
   [mcp-bridge]
        │  REST (GET/POST, Api-Key per agent)
        ├──────────────→ [garage-pi  192.168.1.50:8314]   (pi-gpio-api)
        └──────────────→ [shed-pico  192.168.1.51:8314]   (pico-gpio-api)
```

## Requirements

**Node.js 20 or newer**, with `node` and `npx` on your PATH. If you do not have it, take the LTS build from [nodejs.org](https://nodejs.org/en/download). Nothing else is needed: the MCP protocol (JSON-RPC 2.0 over stdio or Streamable HTTP) is hand-rolled on Node built-ins, so the package has zero dependencies.

You also need at least one GPIO agent reachable on your LAN, a [`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api) Pi or a [`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api) Pico W. This bridge acts strictly as a control plane to drive them remotely.

## Quick start, nothing to install

Let Claude Desktop fetch and start the app itself. One step directly via `npx`. `npx` fetches the published package and runs it ephemerally.

Open Claude Desktop's **Settings → Developer → Edit Config**, which opens `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS or the equivalent file on Windows or Linux, and add the server under `mcpServers`:

```json
{
  "mcpServers": {
    "ctrlpi": {
      "command": "npx",
      "args": ["-y", "@ctrlpi/mcp-bridge"]
    }
  }
}
```

Restart Claude Desktop and the tools are there. Ask it what agents you have and it will call `mcp_agents_list`; from then on it can read pins, drive outputs, and configure the agents in plain conversation.

The first launch sweeps your local /24 and writes every agent it finds to `~/.ctrlpi/config.json`. By default, newly discovered agents are recorded using their shipped default keys. (You can append `--rotate-keys` to the `args` array to automatically generate and apply a new random key to each one.)

The sweep repeats on every launch and every hour after it, which is what picks up an agent switched on later and repairs the address of one that took a new DHCP lease (a Pico nearly always does on reset). Add `--no-scan` to turn that off once your setup has settled, and take it out again the day something moves.

## Install

Install it properly when you want to own the process, or when **the bridge runs on a Pi** and has to be reachable from Claude Desktop and other clients on different machines. Under `npx` the server lives and dies with the client that started it and is refetched as needed; installed, it stays in one place and you start and stop it yourself.

```bash
npm install @ctrlpi/mcp-bridge
cd node_modules/@ctrlpi/mcp-bridge
node server.js --http
```

It listens on port **8315** on every interface, so any client on the LAN reaches it at `http://<host>:8315/mcp`. Set `mcp.api_key` before you expose it: HTTP mode is key-gated, and the first caller to connect with a key of its own claims it (see [Authentication](#authentication)). `--local` keeps the listener on loopback instead.

### Keep it running

HTTP mode is intended for continuous background execution; a stdio server is started and stopped by the client that owns it. To leave the HTTP transport running on a Pi without a terminal open, start it under [PM2](https://pm2.keymetrics.io):

```bash
npm install -g pm2       # if you don't already have it
pm2 startup              # no need to repeat if already done
pm2 start server.js --name mcp-bridge -- --http
pm2 save
```

`--name mcp-bridge` is not optional: PM2 would otherwise name the process after the script and call it `server`. `mcp-bridge` is the name the rest of the ctrlPi tooling looks for when it manages this process. The `--` is not optional either, or PM2 reads `--http` as one of its own flags and starts nothing.

## Run

Run it with `node server.js` from the installation folder (`node_modules/@ctrlpi/mcp-bridge`), or `npx -y @ctrlpi/mcp-bridge` with no install at all. The arguments below are identical either way.

**stdio** is the default and communicates directly over standard input/output: the transport is the process's own stdin and stdout, and the client that launched it owns both. Everything the server would print goes to stderr instead, because stdout is the protocol channel. This is the mode Claude Desktop uses.

**`--http`** serves Streamable HTTP at `POST /mcp` on port **8315**, one above the agents' own 8314, for a client that cannot launch a local process or sits on another machine. It is a server: it stays up, holds a port, and requires `mcp.api_key` from every caller (see [Authentication](#authentication)).

### Run flags

| Flag&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; | Effect |
|:---------------------|:-------|
| *(none)*             | Runs the stdio MCP server, the default transport. |
| `--http`             | Serves Streamable HTTP at `POST /mcp` instead, on all interfaces (`0.0.0.0`). |
| `--local`            | Binds to loopback (`127.0.0.1`) only. |
| `--host <ip>`        | Explicit bind address; wins over `--local`. |
| `--port <n>`         | Listen port (default `8315`). |
| `--rotate-keys`      | Replace the shipped default key on any agent still using it with a random one, and record the date under `key_set`. |
| `--no-scan`          | Never sweep the LAN, at startup or after. A first run with no config still sweeps once, since there would be no agents at all otherwise. |
| `--config <folder>`  | Keep both config files in this folder instead of `~/.ctrlpi/`. |

### Connect from Claude Desktop

For the ordinary case, where Claude Desktop launches the server itself over stdio, use the `npx` form under [Quick start](#quick-start-nothing-to-install). Substitute `"command": "node", "args": ["<path>/node_modules/@ctrlpi/mcp-bridge/server.js"]` if you installed it instead.

To reach a bridge over the network, start it in HTTP mode first (`node server.js --http`), then connect through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), passing `mcp.api_key` (`your-mcp-key` by default, see [Configuration](#configuration)):

```json
{
  "mcpServers": {
    "ctrlpi": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "http://<host>:8315/mcp",
        "--header", "Api-Key:your-mcp-key"
      ]
    }
  }
}
```

Pick one of the two, not both. Restart Claude Desktop after saving either.

### Connect from Claude Code

Claude Code speaks both transports directly, so no `mcp-remote` hop is needed. Pick one.

**stdio**, where Claude Code launches its own copy:

```bash
claude mcp add ctrlpi -- npx -y @ctrlpi/mcp-bridge
```

**Streamable HTTP**, attaching to a bridge already running with `--http`:

```bash
claude mcp add ctrlpi --transport http http://<host>:8315/mcp --header "Api-Key: your-mcp-key"
```

## Authentication

Two independent keys are in play, and they are never the same one:

| Key | Where it lives | What it does |
|---|---|---|
| `mcp.api_key` | `~/.ctrlpi/mcp-config.json` | Gates **this server** in `--http` mode. Sent as an `Api-Key` header, the only form accepted. Starts as `your-mcp-key` and is claimed on first use, below. |
| `agents[].api_key` | `~/.ctrlpi/config.json` | Each **agent's** own key, forwarded on every proxied REST call. Never sent to an MCP client. |

**stdio mode needs no key at all**: the transport is the process's own stdin/stdout, so whoever launched it already has that access.

### Claiming the HTTP key

While `mcp.api_key` is still the shipped `your-mcp-key`, the **first caller to present a different key claims it**: that key is written to `mcp-config.json` with the date under `mcp.key_set`, and from that moment it is the only key accepted. Just connect with the secret you want to use and it becomes the secret.

This is trust on first use, so the window is exactly as safe as your network during it: whoever reaches the port first sets the key. Set `mcp.api_key` by hand to skip the window, and keep `--http` off an untrusted LAN until a key is in place. Once claimed, the key only ever changes by editing the file.

> **No TLS.** The HTTP transport speaks plain HTTP, so `mcp.api_key` travels as plaintext. That's fine on a trusted LAN, but don't expose port 8315 directly to the internet. If you need remote access, tunnel it. `--local` keeps the listener on loopback. The key is exclusively read from the `Api-Key` header, keeping it out of shell history and proxy logs.

## Tools

Every tool except `mcp_agents_list` takes an `agent` argument naming an entry from the shared `~/.ctrlpi/config.json`.

| Tool | Description |
|------|-------------|
| `mcp_agents_list(rescan)` | List all configured agents with `name`, `ip`, `port`, `online` (live `/hello` probe), `type` (`pi` / `pico`), `version` (from `/config/read`), and `last_updated_at`. Unreachable agents are listed too, marked `online=false`. The LAN is scanned automatically every hour to find new agents. Pass `rescan=true` to actively force a network sweep right now (note: this takes a long time, so use it only when explicitly looking for new hardware). |
| `mcp_gpio_read(agent, name_or_gpio)` | Read a pin by number or name. Pass `"all"` to read every configured pin. |
| `mcp_gpio_write(agent, name_or_gpio, value, duration)` | Write `"0"`, `"1"`, `"on"`, `"off"` or `"toggle"`. Optional `duration` (seconds) pulses the pin and reverts it; a pin's configured `max` clamps that, and supplies it when no duration is given. |
| `mcp_gpio_config(agent, gpio, name, type, init, pullup, max, reversed, watched)` | Configure a pin. Same fields as the agent's REST config endpoint. |
| `mcp_gpio_watched(agent)` | List the GPIO pins that are currently being actively watched (emitting hardware interrupts/webhooks). |
| `mcp_gpio_scan(agent)` | Scan every hardware pin (BCM 2-27 on a Pi, GP0-GP28 on a Pico). |
| `mcp_sensor_config(agent, name, script, remove)` | Configure a named sensor. `script` is `"<file> [args...]"`: a bare filename in the agent's `scripts/` folder, letters/digits-only args. A shell script on a Pi, a `.py` the agent execs in-process on a Pico. Pass `remove=true` to delete it. |
| `mcp_sensor_read(agent, name)` | Read one sensor by name, or every configured sensor merged into one object when `name` is omitted. |
| `mcp_config_read(agent)` | Read the agent's full config: `notifications`, `bridges`, `settings`, `sensors`, `gpios`, plus the live `agent` block. |
| `mcp_config_write(agent, name, api_key, webhook_url, webhook_key, docs_enabled, logs_enabled, log_days)` | Update config fields, named ungrouped (the agent routes each into its group). Changing the agent's `api_key` takes effect immediately, and the bridge automatically updates its entry in the shared `config.json` to match. |
| `mcp_config_load(agent, config)` | Load a whole config onto the agent. Pass `{}` to reset it, keeping only its API key. |
| `mcp_agent_restart(agent, reboot)` | Restart the agent's process. `reboot=true` reboots the physical device (honored on a real Pi only). |
| `mcp_agent_upgrade(agent)` | Upgrade the agent in place: downloads the latest release and reinstalls dependencies, then restarts. |
| `mcp_agent_logs(agent)` | Read the last 50 lines of the agent's log. |

Tools return the agent's JSON response as text, or an `Error: ...` string when the agent is unknown, unreachable, or answers with an error status.

## Configuration

> **Where the config lives:** in `~/.ctrlpi/`, always - never next to `server.js`, however you started it. Pass `--config <folder>` to keep both somewhere else; they are always named the same and always sit together.

Two files. Neither ships with the package: the first run builds both from a LAN scan, so there is no template to copy.

**`~/.ctrlpi/config.json`** - the agents, shared with every other ctrlPi project:

```json
{
    "agents": [
        { "name": "garage-pi", "ip": "192.168.1.50", "port": 8314,
          "api_key": "a1b2c3d4e5f60718293a4b5c", "key_set": "2026-08-20 14:23:13" },
        { "name": "shed-pico", "ip": "192.168.1.51", "port": 8314,
          "api_key": "shed-pico-secret-key" }
    ]
}
```

**`~/.ctrlpi/mcp-config.json`** - what only this server owns:

```json
{
    "mcp": { "api_key": "your-mcp-key" },
    "agents": { "whitelist": [], "blacklist": [] }
}
```

| Field | File | Description |
|-------|------|-------------|
| `mcp.api_key` | `mcp-config.json` | Secret required to reach this server **in HTTP mode**. Ignored in stdio mode. Starts as `your-mcp-key` and is claimed on first use (see [Claiming the HTTP key](#claiming-the-http-key)). |
| `mcp.key_set` | `mcp-config.json` | When `mcp.api_key` was claimed, UTC `YYYY-MM-DD HH:MM:SS`. Absent if the key was set by hand. |
| `agents.whitelist` / `agents.blacklist` | `mcp-config.json` | Optional. Agent **names** this server may drive: a whitelist keeps only those, a blacklist drops those, both means whitelist minus blacklist, neither means all of them. Tools exclusively see agents permitted by the filter, ensuring only approved agents can be addressed. |
| `agents[].name` | `config.json` | Unique name used to target the agent in every tool call. |
| `agents[].ip` | `config.json` | LAN IP or hostname of the agent's REST server. |
| `agents[].port` | `config.json` | REST port (optional, default `8314`). |
| `agents[].api_key` | `config.json` | That agent's own `Api-Key`, forwarded on every proxied request. |
| `agents[].key_set` | `config.json` | When `api_key` was last set by `--rotate-keys`, UTC `YYYY-MM-DD HH:MM:SS`. Absent on an agent whose key this app never set. Anything that changes an agent's key should update it. |

Both files are re-read on every tool call, so adding, removing or re-keying an agent by hand takes effect without a restart. The filter is applied only to what tools see: discovery always saves the full shared list, so narrowing it here strictly preserves other projects' agents in the shared list.

## Agent discovery

The agent list keeps itself current. **Every start sweeps the local /24, and so does every hour after that**, so an agent switched on later is picked up without anyone restarting anything. `--no-scan` turns all of it off.

Each sweep is one scan feeding three passes, in this order:

1. **Repair** the address of any agent that moved. Agents take new DHCP leases (a Pico nearly always does on reset), which otherwise breaks every call to it.
2. **Rotate** the key of anything still on the shipped default, with `--rotate-keys` only.
3. **Add** whatever is left that isn't on record yet.

Repair runs first on purpose: an agent that merely moved is not a new agent, and adding it before its address is fixed would file it twice, the second time as `<name>-<octet>`.

Newly found agents are filed under whichever key applies. Setup decisions are made autonomously using command-line flags, accommodating MCP clients that launch the server without a console.

- It still accepts the shipped **default** key (`your-secret-key`). With `--rotate-keys`, a random key is written to the agent (`POST /config/update`), verified by reading back with it, then saved here with today's date in `key_set`. Without the flag the agent is recorded on the default key, untouched.
- The default key is **refused**, so the agent already has a key of its own that this app has no way to read. It is saved without a key, requiring manual configuration of `api_key`.

`--rotate-keys` also revisits agents **already on file** that are still on the default key, so adding the flag later secures a setup that was first discovered without it. It is safe to leave on permanently: an agent that already has a key of its own is never touched, which makes repeat runs a no-op.

An agent's key is only ever changed when this app can save the result, so a rotation that cannot be recorded never happens - the alternative locks that agent out of every other ctrlPi tool.

A moved agent is adopted only after the **old** address stops answering, and it is checked with the public default key first - its own key is only ever offered once the old address is confirmed dead, so a device that merely took a familiar name is never handed that agent's key.

If two devices answer to one name, that is reported as a possible **cyber attack**. When the configured address is still alive it is treated as genuine and the other is renamed on the device (only if it accepts the default key); when it is also dead, nothing is changed - there is no safe way to tell which is which.

## Why no webhook listener?

mcp-bridge is an inbound control plane only; it never receives the agents' webhooks, by design:

- **Push can't wake the model.** MCP clients invoke the server, not the other way round; a webhook arriving here couldn't start a Claude conversation, so a listener wouldn't make the AI reactive. Reactive automation is the bridges' job (`homekit-bridge` :8316, `matter-bridge` :8317).
- **Lifecycle.** In stdio mode the server only lives while the MCP client session is open, so events outside a session would be lost.

## Related projects

- **[`pi-gpio-api`](https://github.com/ctrlpi/pi-gpio-api)**: Raspberry Pi GPIO REST server that reads inputs and drives outputs (and named sensors) over an HTTP API.
- **[`pico-gpio-api`](https://github.com/ctrlpi/pico-gpio-api)**: Raspberry Pi Pico W port of the GPIO REST server, with the same endpoints, wire format, and auth.
- **`homekit-bridge`** *(coming soon)*: native Apple HomeKit bridge that exposes GPIO pins and sensors as HomeKit accessories, driven over the agents' REST API.
- **`matter-bridge`** *(coming soon)*: Matter bridge that exposes GPIO pins and sensors to any Matter platform (Apple Home, Google Home, Alexa, Home Assistant), driven over the agents' REST API.
- **`ctrlpi-lab`** *(coming soon)*: Web dashboard for monitoring and controlling agents over REST API and MCP.

## Testing

The MCP server includes an integration test suite that runs against a mock agent. Note: running the tests requires Python 3 installed locally for the mock server (`mock_agent.py`).

```bash
npm test
```

## License

[MIT](http://localhost:8181/LICENSE)

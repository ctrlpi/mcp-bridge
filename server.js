#!/usr/bin/env node
// mcp-bridge - an MCP server that controls one or more GPIO agents (Raspberry Pi
// or Pico W) by calling their REST API over HTTP.
//
// This app acts as an API proxy. It routes tool calls to remote agents by name (from
// config.json) using their `pi-gpio-api` / `pico-gpio-api`
// REST endpoints, forwarding the agent's own `Api-Key`. Run it over stdio (for local
// MCP clients like Claude Desktop) or over Streamable HTTP (for networked clients).

// This server implements the MCP protocol (JSON-RPC 2.0 over stdio or Streamable HTTP)
// using Node built-ins to provide a focused API surface: a handful of methods
// (initialize, tools/list, tools/call) and two transports.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const readline = require("readline");
const { randomUUID, timingSafeEqual } = require("crypto");

// --- Where the config files live ---------------------------------------------------
// Everything lives in ~/.ctrlpi/ (or the folder specified by --config).
// Two files, both flat in that one directory:
//
//   config.json      the SHARED agent list (name/ip/port/api_key/key_set) - every ctrlpi
//                    project reads it and any of them may update it
//   mcp-config.json  only what this server owns: `mcp` (its own HTTP-mode key, plus the
//                    ip/port gpio-lab records for it) and an optional agents
//                    whitelist/blacklist (see selectAgents below)
//
// Both files always sit together in the same directory.
function resolveConfigFile(fileName) {
    const args = process.argv.slice(2);
    const i = args.indexOf("--config");
    let dir = path.join(os.homedir(), ".ctrlpi");
    if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) {
        dir = path.resolve(args[i + 1]);
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
        console.error(`Could not create ${dir}: ${e.message}`);
    }
    return path.join(dir, fileName);
}

const CONFIG_FILE = resolveConfigFile("mcp-config.json");
const SHARED_FILE = path.join(path.dirname(CONFIG_FILE), "config.json");
const STATE_DIR = path.dirname(CONFIG_FILE);
const DEFAULT_PORT = 8314; // default REST port for agents that don't specify one
const DEFAULT_AGENT_KEY = "your-secret-key"; // pi-gpio-api / pico-gpio-api's default Api-Key
const DEFAULT_HTTP_KEY = "your-mcp-key"; // this server's own default key, gating --http mode
const MAX_BODY_BYTES = 64 * 1024; // largest accepted --http request body, else 413. The biggest
                                  // real one is mcp_config_load carrying a full agent config: a
                                  // fully-populated Pi (26 pins + sensors) measures under 5 KB,
                                  // so this is an abuse guard, not a limit anything legitimate meets
const HTTP_TIMEOUT = 20000; // per-call timeout when proxying to an agent (ms)
const PROBE_TIMEOUT = 3000; // shorter timeout for liveness/type probes in agents_list (ms)
const CONFIG_MAX_AGE = 3600; // seconds; mcp_agents_list re-scans the LAN when config.json is older
const SWEEP_INTERVAL = CONFIG_MAX_AGE; // seconds between the background sweeps that keep the agent
                                       // list current while the server runs. Same period as the
                                       // staleness rule above, so the two never disagree about
                                       // when the list is old
const SCAN_TIMEOUT = 1500; // /hello timeout during a /24 sweep - a Zero 2 W or a Pico often
                           // misses a shorter window, and an agent the scan misses is one
                           // this server never sees
const SCAN_BATCH = 48;     // hosts probed at once; a Pico serves one connection at a time and
                           // drops probes when the whole /24 is fired simultaneously

// --- First-run setup: scan the LAN for agents and build config.json ---

function localIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = HTTP_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeHello(ip, port = DEFAULT_PORT, timeoutMs = SCAN_TIMEOUT) {
  // One unauthenticated /hello. Returns {ip, name} or null. /hello needs no key, so this
  // is safe to point at any address - nothing of ours is disclosed by asking.
  try {
    const r = await fetchWithTimeout(`http://${ip}:${port}/hello`, {}, timeoutMs);
    if (r.status === 200) {
      const body = await r.json();
      return { ip, port, name: body.name || ip };
    }
  } catch {
    // unreachable host, ignore
  }
  return null;
}

async function scanForAgents(port = DEFAULT_PORT, timeoutMs = SCAN_TIMEOUT) {
  // Probe every host on the local /24 for an unauthenticated /hello, like
  // ctrlpi-api-tester/ctrlpi-cli.py's discovery. Returns [{ip, name, port}, ...].
  const ip = localIp();
  const results = [];
  
  if (ip) {
    const prefix = ip.split(".").slice(0, 3).join(".");
    note(`Scanning ${prefix}.0/24 on port ${port} for agents...`);

    // In batches rather than all 255 at once - see SCAN_BATCH.
    for (let start = 1; start <= 255; start += SCAN_BATCH) {
      const batch = [];
      for (let i = start; i < start + SCAN_BATCH && i <= 255; i++) {
        batch.push(probeHello(`${prefix}.${i}`, port, timeoutMs));
      }
      results.push(...(await Promise.all(batch)));
    }
  }

  // Also scan localhost for mock agents on ports 9314-9319
  note(`Scanning localhost on ports 9314-9319 for mock agents...`);
  const localBatch = [];
  for (let p = 9314; p <= 9319; p++) {
    localBatch.push(probeHello("127.0.0.1", p, timeoutMs));
  }
  results.push(...(await Promise.all(localBatch)));

  return results.filter(Boolean);
}

// Setup runs autonomously based on command-line flags, allowing MCP clients to launch
// the server in the background.
//
// Stdio mode suppresses setup logs to keep the JSON-RPC channel clean; HTTP mode logs
// setup progress to the console.
let SETUP_QUIET = false;
function note(msg) {
  if (!SETUP_QUIET) console.error(msg);
}

function randomKey() {
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

// UTC "YYYY-MM-DD HH:MM:SS", the same shape the agents use for their own `config_updated`.
function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

async function agentAcceptsKey(ip, port, key) {
  try {
    const r = await fetchWithTimeout(`http://${ip}:${port}/config/read`, {
      headers: { "Api-Key": key },
    }, 3000);
    return r.status === 200;
  } catch {
    return false;
  }
}

async function setAgentKey(ip, port, currentKey, newKey) {
  // Rotate the agent's own key over its REST API, then confirm the new one works.
  const r = await fetchWithTimeout(`http://${ip}:${port}/config/update`, {
    method: "POST",
    headers: { "Api-Key": currentKey, "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: newKey }),
  }, 5000);
  if (r.status !== 200) throw new Error(`/config/update returned ${r.status}`);
  if (!(await agentAcceptsKey(ip, port, newKey))) throw new Error("new key was not accepted afterwards");
}

// Decide what key to file an agent under. Returns { api_key, key_set? }, ready to spread onto
// the agent's entry: `key_set` is present only when this run actually set the key. The
// stamp indicates exactly when this key was first applied.
async function resolveAgentKey(ip, port, rotateKeys) {
  if (await agentAcceptsKey(ip, port, DEFAULT_AGENT_KEY)) {
    // Still on the key it shipped with, which every ctrlpi user knows. --rotate-keys replaces
    // it with a random one; without the flag nothing is touched, since rotating is close to
    // irreversible (the new key exists only in config.json) and must always be asked for.
    if (!rotateKeys) {
      note(`    on the default key, left unchanged (pass --rotate-keys to secure it)`);
      return { api_key: DEFAULT_AGENT_KEY };
    }
    const newKey = randomKey();
    try {
      await setAgentKey(ip, port, DEFAULT_AGENT_KEY, newKey);
      note(`    key rotated`);
      return { api_key: newKey, key_set: nowStamp() };
    } catch (e) {
      note(`    could not rotate the key (${e.message}) - left on the default`);
      return { api_key: DEFAULT_AGENT_KEY };
    }
  }
  note(`    already has its own key, which this app cannot read - set api_key in config.json`);
  return { api_key: "" };
}

// Second half of --rotate-keys: agents already on file, still sitting on the default key
// because an earlier run had no flag. Without this the flag would only ever work once, on
// the run that first discovered an agent. Returns true if anything changed.
async function rotateConfiguredKeys(config) {
  let changed = false;
  for (const a of config.agents || []) {
    if (a.api_key && a.api_key !== DEFAULT_AGENT_KEY) continue;
    const port = a.port || DEFAULT_PORT;
    if (!(await agentAcceptsKey(a.ip, port, DEFAULT_AGENT_KEY))) continue;  // offline, or already keyed
    const newKey = randomKey();
    try {
      await setAgentKey(a.ip, port, DEFAULT_AGENT_KEY, newKey);
      a.api_key = newKey;
      a.key_set = nowStamp();
      changed = true;
      note(`  ${a.name} (${a.ip}): key rotated`);
    } catch (e) {
      note(`  ${a.name} (${a.ip}): could not rotate the key (${e.message})`);
    }
  }
  return changed;
}

async function searchAndAddAgents(rotateKeys, found = null) {
  // Add anything the sweep found that isn't on file yet, deciding each one's key from the
  // flags. Agents already in the file keep their key (only --rotate-keys revisits those, in
  // rotateConfiguredKeys). Works on the FULL shared list to ensure all agents are updated.
  const config = loadSetupConfig();
  const agents = config.agents || [];
  const knownIps = new Set(agents.map((a) => `${a.ip}:${a.port || DEFAULT_PORT}`));
  const knownNames = new Set(agents.map((a) => a.name));
  if (!found) found = await scanForAgents();
  const fresh = found.filter(({ ip, port }) => !knownIps.has(`${ip}:${port || DEFAULT_PORT}`));

  // A name already in the config is NOT a new agent. Normally reconcileAgents() has moved
  // it and its address matches, so it never reaches here; if it does, adopting failed -
  // and adding it as "<name>-<octet>" would leave two entries for one device.
  const sameName = fresh.filter(({ name }) => knownNames.has(name));
  const toAdd = fresh.filter(({ name }) => !knownNames.has(name));
  for (const { ip, port, name } of sameName) {
    note(`  '${name}' (${ip}:${port || DEFAULT_PORT}) is already configured under that name - not adding it. ` +
         `Its address could not be reconciled; check config.json.`);
  }
  if (!toAdd.length) {
    if (!sameName.length) {
      note(agents.length ? "No new agents found." : "No agents found. You can add them later by editing config.json.");
    }
  } else {
    note(`Found ${toAdd.length} new agent(s):`);
    for (const { ip, port, name } of toAdd) {
      knownNames.add(name);
      note(`  ${name} (${ip}:${port || DEFAULT_PORT})`);
      const key = await resolveAgentKey(ip, port || DEFAULT_PORT, rotateKeys);
      agents.push({ name, ip, port: port || DEFAULT_PORT, ...key });
    }
  }
  // Merge updates into the shared file: the `agents` key is written while preserving
  // all other existing configuration properties used by other projects.
  config.agents = agents;
  saveConfig(config);
  note(`Saved ${SHARED_FILE} with ${agents.length} agent(s).`);
  note(`HTTP-mode key (only used by --http) defaults to '${DEFAULT_HTTP_KEY}' - change mcp.api_key in ${CONFIG_FILE} for a real secret.`);
  note("");
}

async function renameAgent(ip, port, key, newName) {
  // Rename an agent over its own REST API - used for breaking a duplicate name.
  const r = await fetchWithTimeout(`http://${ip}:${port}/config/update`, {
    method: "POST",
    headers: { "Api-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ name: newName }),
  }, 5000);
  if (r.status !== 200) throw new Error(`/config/update returned ${r.status}`);
}

async function reconcileAgents(config, { rotate = false, found = null } = {}) {
  // Runs on every start that has agents configured: agents take new DHCP leases (a Pico
  // nearly always does on reset), so an IP in config.json goes stale without anything
  // being wrong. Sweeps the LAN and repairs entries whose agent simply moved. Adds
  // nothing - the add pass in sweep() does that. Returns true if config.json was rewritten.
  const agents = config.agents || [];
  if (!agents.length) return false;

  if (!found) found = await scanForAgents();
  if (!found.length) return false;
  let changed = false;

  for (const a of agents) {
    const port = a.port || DEFAULT_PORT;
    // Exact name match only: a config label that was de-duplicated on add ("pico-6c28-104")
    // no longer equals what the agent calls itself, and guessing at that is how the wrong
    // device gets adopted.
    const claimants = found.filter((f) => f.name === a.name);
    if (!claimants.length) continue;                                  // offline, or renamed
    if (claimants.length === 1 && claimants[0].ip === a.ip) continue;  // where we left it

    // Is the configured agent still answering at its stored address, under its own name?
    const atOld = await probeHello(a.ip, port);
    const aliveAtOld = !!atOld && atOld.name === a.name;

    if (claimants.length > 1) {
      console.error(`[SECURITY] '${a.name}' is claimed by ${claimants.length} addresses ` +
                    `(${claimants.map((c) => c.ip).join(", ")}) - possible cyber attack.`);
      if (!aliveAtOld) {
        // No way to tell which one is the agent we know: the address we trusted is gone
        // and every claimant is equally (un)convincing. Touch nothing.
        console.error(`  ${a.name} does not answer at its configured ${a.ip} either - ` +
                      `leaving it alone; fix config.json by hand.`);
        continue;
      }
      // The configured address answered, so that one is genuine and the rest are impostors.
      for (const other of claimants.filter((c) => c.ip !== a.ip)) {
        const otherPort = other.port || DEFAULT_PORT;
        if (!(await agentAcceptsKey(other.ip, otherPort, DEFAULT_AGENT_KEY))) {
          console.error(`  ${other.ip}:${otherPort} does not accept the default key - cannot rename it, ` +
                        `leaving it as '${a.name}'.`);
          continue;
        }
        const newName = `${a.name}-${other.ip.split(".").pop()}`;
        try {
          await renameAgent(other.ip, otherPort, DEFAULT_AGENT_KEY, newName);
          other.name = newName;   // so the add pass files it under the name it now has
          console.error(`  Renamed ${other.ip}:${otherPort} to '${newName}'.`);
          if (rotate) {
            const key = randomKey();
            try {
              await setAgentKey(other.ip, otherPort, DEFAULT_AGENT_KEY, key);
              console.error(`  Rotated the key on ${other.ip}:${otherPort}.`);
            } catch (e) {
              console.error(`  Could not rotate the key on ${other.ip}:${otherPort} (${e.message}).`);
            }
          }
        } catch (e) {
          console.error(`  Could not rename ${other.ip}:${otherPort} (${e.message}).`);
        }
      }
      continue;
    }

    // Exactly one claimant, at an address that isn't the one on file.
    const moved = claimants[0];
    const movedPort = moved.port || DEFAULT_PORT;
    if (aliveAtOld) {
      // Both answer to the name. Same collision as above, just discovered from the other
      // side, so it gets the same treatment rather than a silent move.
      console.error(`[SECURITY] '${a.name}' answers at both ${a.ip}:${port} and ${moved.ip}:${movedPort} - ` +
                    `possible cyber attack; not moving it.`);
      continue;
    }
    // The old address is dead, so this is a moved agent rather than a stranger. Try the
    // DEFAULT key first: it is public, and offering it costs nothing. If that fails,
    // the agent's specific key is used. Verifying the old address is dead ensures the
    // key is only sent to the genuine moved agent.
    let key = null;
    if (await agentAcceptsKey(moved.ip, movedPort, DEFAULT_AGENT_KEY)) key = DEFAULT_AGENT_KEY;
    else if (a.api_key && a.api_key !== DEFAULT_AGENT_KEY &&
             await agentAcceptsKey(moved.ip, movedPort, a.api_key)) key = a.api_key;

    if (!key) {
      note(`'${a.name}' looks like it moved to ${moved.ip}:${movedPort}, but neither the ` +
           `default key nor its own was accepted - leaving ${a.ip}:${port} on file.`);
      continue;
    }
    const reset = key !== a.api_key;
    note(`'${a.name}' moved ${a.ip}:${port} -> ${moved.ip}:${movedPort}` + (reset ? " (key reset to the default)" : "") + ".");
    a.ip = moved.ip;
    a.port = movedPort;
    a.api_key = key;   // whichever key answered IS this agent's key now
    // The stamp describes the key it sits beside, so a key we did not set has no date:
    // the agent was reflashed or hand-edited, and the old date would now be a lie.
    if (reset) delete a.key_set;
    changed = true;
  }

  // After all moves are settled, if any agent is currently active on an endpoint,
  // ensure no OTHER agent in config.json is still claiming that endpoint.
  // This clears stale IPs from agents that went offline and whose lease was taken by someone else.
  for (const c of found) {
    const cEndpoint = `${c.ip}:${c.port || DEFAULT_PORT}`;
    for (const a of agents) {
      if (a.ip && `${a.ip}:${a.port || DEFAULT_PORT}` === cEndpoint && a.name !== c.name) {
        note(`Clearing stale IP ${a.ip} from '${a.name}' (now occupied by live agent '${c.name}').`);
        a.ip = "";
        changed = true;
      }
    }
  }

  if (changed) {
    config.agents = agents;
    saveConfig(config);
    note(`Updated ${SHARED_FILE}.`);
  }
  return changed;
}

async function rescanAgents() {
  // Re-scan the LAN and merge any newly discovered agents into the shared config.json,
  // preserving existing entries (and their hand-edited keys/names). Non-interactive - new
  // agents get the default Api-Key. Always rewrites that file, which refreshes its mtime so
  // the next auto-rescan is at least CONFIG_MAX_AGE away. Returns the runtime (filtered)
  // config, since that is what the caller hands back to a tool.
  const config = loadSetupConfig();
  const agents = config.agents || [];
  const knownIps = new Set(agents.map((a) => a.ip));
  const usedNames = new Set(agents.map((a) => a.name));
  for (const { ip, name: rawName } of await scanForAgents()) {
    if (knownIps.has(ip)) continue;
    let name = rawName;
    if (usedNames.has(name)) name = `${name}-${ip.split(".").pop()}`;
    usedNames.add(name);
    knownIps.add(ip);
    agents.push({ name, ip, port: DEFAULT_PORT, api_key: DEFAULT_AGENT_KEY });
  }
  config.agents = agents;
  saveConfig(config);
  return loadConfig();
}

function configIsStale() {
  // True when the shared config.json is missing or older than CONFIG_MAX_AGE - the trigger
  // for an automatic LAN re-scan in mcp_agents_list. It is the agent list that goes stale,
  // so it is that file's mtime that matters, not this server's own settings file.
  try {
    const ageSec = (Date.now() - fs.statSync(SHARED_FILE).mtimeMs) / 1000;
    return ageSec > CONFIG_MAX_AGE;
  } catch {
    return true;
  }
}

// --- Config / agent lookup ---

function readJsonFile(file) {
  // Both files are read fresh on every access so edits take effect without a restart.
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    console.error(`Warning: could not parse ${file}: ${e.message}`);
    return {};
  }
}

const loadOwn = () => readJsonFile(CONFIG_FILE);
const loadSharedAgents = () => {
  const shared = readJsonFile(SHARED_FILE);
  return Array.isArray(shared.agents) ? shared.agents : [];
};

// The shared config.json is the only place agents are defined. This server's own file may
// narrow that list with `agents: { whitelist, blacklist }` - agent names, matched exactly:
// a whitelist alone keeps only those, a blacklist alone drops those, both means whitelist
// minus blacklist, and neither (or an empty object) means every agent in the shared file.
function selectAgents(all, filter) {
  const list = Array.isArray(all) ? all : [];
  if (!filter || Array.isArray(filter) || typeof filter !== "object") return list;
  const names = (v) => (Array.isArray(v) ? v : []).map(String);
  const white = names(filter.whitelist), black = names(filter.blacklist);
  let out = white.length ? list.filter((a) => white.includes(a.name)) : list;
  if (black.length) out = out.filter((a) => !black.includes(a.name));
  return out;
}

// The runtime view: this server's own settings, with the agent list read out of the shared
// file and narrowed by the filter. Tools only ever see agents this server is allowed to
// drive - an agent outside the filter is not "unreachable", it simply isn't there.
function loadConfig() {
  const own = loadOwn();
  return { ...own, agents: selectAgents(loadSharedAgents(), own.agents) };
}

// The setup view: returns the full unfiltered agent list for discovery and repairs.
function loadSetupConfig() {
  return { ...loadOwn(), agents: loadSharedAgents() };
}

// Saves agents to the shared config, and everything else to the local config.
function saveConfig(config) {
  let list = config.agents || [];
  // Deduplicate agents by name, keeping the one with the newest key_set
  const byName = {};
  for (const a of list) {
    if (!byName[a.name]) byName[a.name] = [];
    byName[a.name].push(a);
  }
  list = [];
  for (const name of Object.keys(byName)) {
    const group = byName[name];
    if (group.length === 1) {
      list.push(group[0]);
    } else {
      group.sort((a, b) => (b.key_set || "").localeCompare(a.key_set || ""));
      list.push(group[0]);
      note(`Deduplicated '${name}': kept ${group[0].ip}:${group[0].port || DEFAULT_PORT}, removed ${group.slice(1).map(x => x.ip + ":" + (x.port || DEFAULT_PORT)).join(", ")}`);
    }
  }
  config.agents = list;

  const shared = readJsonFile(SHARED_FILE);
  shared.agents = list;
  fs.writeFileSync(SHARED_FILE, JSON.stringify(shared, null, 4));
  const own = loadOwn();
  if (config.mcp) own.mcp = { ...(own.mcp || {}), ...config.mcp };
  ensureHttpKey(own);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(own, null, 4));
}

function agents() {
  return loadConfig().agents || [];
}

// This server's own key, gating --http mode.
function httpKey() {
  const own = loadOwn();
  return (own.mcp && own.mcp.api_key) || DEFAULT_HTTP_KEY;
}

function ensureHttpKey(own) {
  if (own.mcp && own.mcp.api_key !== undefined) return own;
  own.mcp = { ...(own.mcp || {}), api_key: DEFAULT_HTTP_KEY };
  return own;
}

function findAgent(name) {
  const lower = String(name).toLowerCase();
  return agents().find((a) => String(a.name || "").toLowerCase() === lower) || null;
}

function baseUrl(agent) {
  return `http://${agent.ip}:${agent.port || DEFAULT_PORT}`;
}

async function callAgent(agentName, method, path_, jsonBody = undefined, timeoutMs = HTTP_TIMEOUT) {
  // Proxy an HTTP call to the named agent. Returns [textResult, errorString];
  // exactly one is non-null.
  const agent = findAgent(agentName);
  if (!agent) {
    return [null, `Error: unknown agent '${agentName}'. Use mcp_agents_list to see configured agents.`];
  }
  const headers = { "Api-Key": agent.api_key || "" };
  let resp;
  try {
    const options = { method, headers };
    if (jsonBody !== undefined) {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(jsonBody);
    }
    resp = await fetchWithTimeout(baseUrl(agent) + path_, options, timeoutMs);
  } catch (e) {
    return [null, `Error: could not reach agent '${agentName}' at ${agent.ip}: ${e.message}`];
  }
  const rawText = await resp.text();
  let body;
  try {
    body = JSON.stringify(JSON.parse(rawText));
  } catch {
    body = rawText;
  }
  if (resp.status >= 400) {
    return [null, `Error ${resp.status} from agent '${agentName}': ${body}`];
  }
  return [body, null];
}

function coerceValue(v) {
  // Map a string write value onto what the REST API expects (int, or one of the
  // word forms 'on'/'off'/'toggle').
  const s = String(v).trim().toLowerCase();
  if (s === "toggle" || s === "on" || s === "off") return s;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return v;
}

// --- MCP tools ---

// Each tool is { name, description, inputSchema, handler }. `inputSchema` is a plain
// JSON Schema object (draft-07 style). `handler(args)` receives the call's `arguments`
// object and returns an MCP tool result ({ content: [{ type: "text", text }] }).
const TOOLS = [
  {
    name: "mcp_agents_list",
    description:
      "List configured agents (Pi or Pico). Returns name, ip, port, online (live /hello probe), " +
      "type (pi/pico), version, has_default_key, and last_updated_at. Unreachable agents are included (online=false). " +
      "The LAN is scanned automatically every hour (last_updated_at indicates the last scan time). " +
      "You can pass rescan=true to forcefully sweep the LAN for new agents right now, but avoid doing " +
      "this unless the user explicitly asks to find new hardware, as active scanning takes a long time. " +
      "If has_default_key is true for any agent, explicitly tell the user they are using " +
      "an insecure default key and ask if they want you to change it.",
    inputSchema: {
      type: "object",
      properties: { rescan: { type: "boolean" } },
    },
    handler: async ({ rescan }) => {
      if (rescan || configIsStale()) await rescanAgents();
      const out = [];
      for (const a of agents()) {
        const { name, ip, port = DEFAULT_PORT } = a;
        const entry = { name, ip, port, online: false, type: "unknown", version: null, has_default_key: a.api_key === DEFAULT_AGENT_KEY };
        if (ip) {
          const base = `http://${ip}:${port}`;
          try {
            entry.online = (await fetchWithTimeout(`${base}/hello`, {}, PROBE_TIMEOUT)).status === 200;
          } catch {
            // stays offline
          }
          if (entry.online) {
            try {
              const cr = await fetchWithTimeout(`${base}/config/read`, {
                headers: { "Api-Key": a.api_key || "" },
              }, PROBE_TIMEOUT);
              if (cr.status === 200) {
                const info = await cr.json();
                // Machine facts moved under `agent` in /config/read (0.9.9+)
                const ai = info.agent || {};
                entry.version = ai.version ?? null;
                const plat = String(ai.platform || "").toLowerCase();
                // "pico" is tested first because it also begins with "pi".
                if (plat.includes("pico")) entry.type = "pico";
                else if (plat.split(/\s+/)[0] === "pi" || plat.includes("raspberry pi")) entry.type = "pi";
                else if (plat) entry.type = plat;
              }
            } catch {
              // leave version/type at defaults
            }
          }
        }
        out.push(entry);
      }
      let last_updated_at = null;
      try {
        last_updated_at = fs.statSync(SHARED_FILE).mtime.toISOString();
      } catch {
        // file might not exist yet
      }
      return { content: [{ type: "text", text: JSON.stringify({ agents: out, last_updated_at }) }] };
    },
  },
  {
    name: "mcp_gpio_read",
    description: "Read a GPIO pin value on `agent` by number or name, or 'all' to read all pins.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, name_or_gpio: { type: "string" } },
      required: ["agent", "name_or_gpio"],
    },
    handler: async ({ agent, name_or_gpio }) => {
      const [result, err] = String(name_or_gpio).toLowerCase() === "all"
        ? await callAgent(agent, "GET", "/gpio/read")
        : await callAgent(agent, "GET", `/gpio/read/${name_or_gpio}`);
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_gpio_write",
    description:
      "Write a value to a GPIO pin on `agent` ('0', '1', 'on', 'off', or 'toggle'). Optional duration in " +
      "seconds, after which the pin reverts to its previous state. If the pin has a configured " +
      "'max' pulse duration, the effective duration is clamped to it - and if no duration is " +
      "given but 'max' is set, 'max' is used as the duration automatically.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name_or_gpio: { type: "string" },
        value: { type: "string" },
        duration: { type: "number" },
      },
      required: ["agent", "name_or_gpio", "value"],
    },
    handler: async ({ agent, name_or_gpio, value, duration }) => {
      const body = { value: coerceValue(value) };
      if (duration !== undefined) body.duration = duration;
      const [result, err] = await callAgent(agent, "POST", `/gpio/write/${name_or_gpio}`, body);
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_gpio_scan",
    description:
      "Scan all hardware GPIO pins on `agent` and return their value, type, pull resistor, " +
      "and name: BCM 2-27 on a Raspberry Pi, GP0-GP28 (minus the WiFi-reserved GP23/24/25/29) " +
      "on a Pico. Only supported on Raspberry Pi / Pico hardware.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/gpio/scan");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_gpio_config",
    description:
      "Configure a GPIO pin on `agent` by number. type: input/output/vcc/gnd/remove. " +
      "init: 0/1/last. pullup: up/down/none (input only). max: max pulse duration in seconds " +
      "(output only). reversed: active-low logic (input/output only). watched: trigger webhook " +
      "on state change (logged on the agent if no notifications.webhook is configured).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        gpio: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        init: { type: "string" },
        pullup: { type: "string" },
        max: { type: "number" },
        reversed: { type: "boolean" },
        watched: { type: "boolean" },
      },
      required: ["agent", "gpio"],
    },
    handler: async ({ agent, gpio, name, type, init, pullup, max, reversed, watched }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (type !== undefined) body.type = type;
      if (init !== undefined) body.init = /^-?\d+$/.test(init) ? parseInt(init, 10) : init;
      if (pullup !== undefined) body.pullup = pullup;
      if (max !== undefined) body.max = max;
      if (reversed !== undefined) body.reversed = reversed;
      if (watched !== undefined) body.watched = watched;
      const [result, err] = await callAgent(agent, "POST", `/gpio/config/${gpio}`, body);
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_gpio_watched",
    description: "List the GPIO pins that are currently being actively watched (the ones emitting hardware interrupts/webhooks).",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/gpio/watched");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_sensor_config",
    description:
      "Configure a named sensor on `agent`. A sensor runs a script and its output is the " +
      "reading. `script` is \"<script-file> [args...]\": a bare filename in the agent's " +
      "scripts/ folder (no paths - that folder is the only allowed location), with " +
      "letters/digits-only arguments. On a Raspberry Pi it is a shell script run with `sh`; " +
      "on a Pico a .py file the agent execs in-process. Pass remove=true to delete the sensor.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name: { type: "string" },
        script: { type: "string" },
        remove: { type: "boolean" },
      },
      required: ["agent", "name"],
    },
    handler: async ({ agent, name, script, remove }) => {
      const body = {};
      if (script !== undefined) body.script = script;
      if (remove !== undefined) body.remove = remove;
      const [result, err] = await callAgent(agent, "POST", `/sensor/config/${name}`, body);
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_sensor_read",
    description:
      "Read sensors on `agent`. With no `name`, reads every configured sensor and returns them " +
      "merged into one JSON object; with a `name`, reads just that sensor. Every reading is nested " +
      "under its sensor's own name: a script emitting a JSON object with several fields nests whole, " +
      "one emitting a single-field object contributes just that field's value, and any other output " +
      "is wrapped the same way.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, name: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent, name }) => {
      const [result, err] = name
        ? await callAgent(agent, "GET", `/sensor/read/${name}`)
        : await callAgent(agent, "GET", "/sensor/read");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_config_read",
    description:
      "Read `agent`'s global application configuration, grouped: `notifications` (`webhook` " +
      "+ `webhook_key`), `bridges` (matter/homekit callbacks), `settings` (docs_enabled, logs_enabled, " +
      "log_days), `sensors`, and configured pins (`gpios`). The `agent` block (platform, os, " +
      "ip, cpu_temperature, version) is computed live on every read and is not stored.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/config/read");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_config_write",
    description:
      "Update `agent`'s global configuration dynamically. These are the ungrouped (root) " +
      "field names; the agent routes each into its group (webhook_url -> notifications.webhook, " +
      "webhook_key -> notifications.webhook_key, docs_enabled/logs_enabled/log_days -> " +
      "settings), so a read afterwards " +
      "shows them nested. log_days controls how long log entries are kept (0-30, clamped; 0 " +
      "clears the log immediately and keeps only the last hour). docs_enabled is Pi-only. " +
      "Changing api_key changes the agent's authentication key immediately, and also updates " +
      "the local config.json file to match automatically.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name: { type: "string" },
        api_key: { type: "string" },
        webhook_url: { type: "string" },
        webhook_key: { type: "string" },
        docs_enabled: { type: "boolean" },
        logs_enabled: { type: "boolean" },
        log_days: { type: "number" },
      },
      required: ["agent"],
    },
    handler: async ({ agent, name, api_key, webhook_url, webhook_key, docs_enabled, logs_enabled, log_days }) => {
      const body = {};
      if (name !== undefined) body.name = name;
      if (api_key !== undefined) body.api_key = api_key;
      if (webhook_url !== undefined) body.webhook_url = webhook_url;
      if (webhook_key !== undefined) body.webhook_key = webhook_key;
      if (docs_enabled !== undefined) body.docs_enabled = docs_enabled;
      if (logs_enabled !== undefined) body.logs_enabled = logs_enabled;
      if (log_days !== undefined) body.log_days = log_days;
      const [result, err] = await callAgent(agent, "POST", "/config/update", body);
      if (!err && api_key !== undefined) {
        const config = loadSetupConfig();
        const a = (config.agents || []).find((x) => x.name === agent);
        if (a) {
          a.api_key = api_key;
          a.key_set = new Date().toISOString().replace("T", " ").substring(0, 19);
          saveConfig(config);
        }
      }
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_config_load",
    description:
      "Load a full config onto `agent` from a dict (the agent saves a backup first). " +
      "Pass an empty dict {} to reset all settings on the agent keeping only its API key.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, config: { type: "object" } },
      required: ["agent", "config"],
    },
    handler: async ({ agent, config }) => {
      const [result, err] = await callAgent(agent, "POST", "/config/load", config);
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_agent_restart",
    description:
      "Restart `agent`'s server process. Pass reboot=true to reboot the physical device " +
      "instead - only honored on a real Raspberry Pi; on Mac/dev agents reboot is ignored and " +
      "the process is restarted as usual.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, reboot: { type: "boolean" } },
      required: ["agent"],
    },
    handler: async ({ agent, reboot }) => {
      const [result, err] = await callAgent(agent, "POST", "/restart", { reboot: !!reboot });
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_agent_upgrade",
    description: "Upgrade the agent in place: runs `install.sh --upgrade` (re-downloads the latest release files and reinstalls dependencies), then restarts the process so the new code takes effect.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "POST", "/upgrade");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
  {
    name: "mcp_agent_logs",
    description: "Read the last 50 lines of `agent`'s server log file.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/logs");
      return { content: [{ type: "text", text: err || result }] };
    },
  },
];

// --- MCP protocol (JSON-RPC 2.0) ---

// Version syncs with package.json automatically.
const SERVER_INFO = { name: "mcp-bridge", version: require("./package.json").version };
// Fallback protocol version (we echo the client's version if provided).
const PROTOCOL_VERSION = "2025-06-18";

async function dispatch(msg) {
  // Handle one JSON-RPC message. Returns a response object for requests, or null for
  // notifications (no `id`) and anything that needs no reply.
  const id = msg && msg.id;
  const isRequest = id !== undefined && id !== null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  const method = msg && msg.method;
  const params = (msg && msg.params) || {};
  try {
    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return isRequest ? fail(-32602, `Unknown tool: ${params.name}`) : null;
        const result = await tool.handler(params.arguments || {});
        return ok(result);
      }
      default:
        // Unknown method: error for requests, silently ignore notifications
        // (e.g. notifications/initialized, notifications/cancelled).
        return isRequest ? fail(-32601, `Method not found: ${method}`) : null;
    }
  } catch (e) {
    return isRequest ? fail(-32603, `Internal error: ${e.message}`) : null;
  }
}

// --- stdio transport ---

function runStdio() {
  // Newline-delimited JSON-RPC over stdin/stdout. Lines are processed one at a time
  // (chained) to keep responses strictly ordered on stdout. All logging routes to stderr
  // to preserve stdout for the protocol channel.
  const rl = readline.createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    chain = chain.then(async () => {
      line = line.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
        return;
      }
      const resp = await dispatch(msg);
      if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
    });
  });
  rl.on("close", () => process.exit(0));
}

// --- Streamable HTTP transport ---

// Constant-time comparison to prevent timing attacks.
function keysMatch(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkApiKey(req, apiKey) {
  // Gates the Streamable HTTP transport on the Api-Key header. No-op when no key is set.
  if (!apiKey) return true;
  if (apiKey === DEFAULT_HTTP_KEY && adoptHttpKey(req.headers["api-key"])) return true;
  return keysMatch(req.headers["api-key"], apiKey);
}

// Trust-on-first-use (TOFU) for the server's HTTP key: the first caller to present
// a non-default key claims it. The key is saved to config and locks out future claims.
function adoptHttpKey(provided) {
  const key = String(provided ?? "");
  if (!key || key === DEFAULT_HTTP_KEY) return false;   // absent, or still the default: no claim
  const own = loadOwn();
  own.mcp = { ...(own.mcp || {}), api_key: key, key_set: nowStamp() };
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(own, null, 4));
  } catch (e) {
    console.error(`[SECURITY] Could not save the adopted mcp.api_key to ${CONFIG_FILE} (${e.message}) - ` +
                  `still on the default key.`);
    return false;   // not persisted, so not adopted: ensures access requires a safely stored key
  }
  console.error(`Api-Key claimed by the first caller and saved to ${CONFIG_FILE}. Only that key is accepted now.`);
  return true;
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...extraHeaders });
  res.end(body);
}

function runHttp(host, port) {
  // MCP Streamable HTTP at POST /mcp. We don't push server-initiated messages, so no SSE.
  // Stateful handshake is mocked: any session id (or none) is accepted.
  const server = http.createServer((req, res) => {
    if (!new URL(req.url, "http://localhost").pathname.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    // httpKey() is evaluated per request so config rotation takes effect without restart.
    if (!checkApiKey(req, httpKey())) {
      sendJson(res, 403, { error: "Invalid or missing Api-Key header" });
      return;
    }
    if (req.method === "DELETE") {
      // Acknowledge session termination cleanly.
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      // 405 correctly signals no SSE stream is available.
      res.writeHead(405, { Allow: "POST, DELETE" }).end();
      return;
    }
    // Collect Buffers and decode once at the end to prevent chunk-split UTF-8 corruption.
    // Capped at MAX_BODY_BYTES to prevent memory exhaustion.
    const chunks = [];
    let size = 0;
    let oversized = false;
    req.on("data", (chunk) => {
      if (oversized) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        sendJson(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", async () => {
      if (oversized) return;   // 413 already sent
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const headers = msg && msg.method === "initialize" ? { "Mcp-Session-Id": randomUUID() } : {};
      const resp = await dispatch(msg);
      if (resp === null) {
        res.writeHead(202, headers).end();  // notification only - nothing to return
        return;
      }
      sendJson(res, 200, resp, headers);
    });
  });
  server.listen(port, host, () => {
    console.log(`INFO:     mcp-bridge Streamable HTTP at http://${host}:${port}/mcp`);
  });
}

// One LAN sweep feeding every pass, in the order they have to run:
//   1. reconcile - repair the address of an agent that took a new DHCP lease
//   2. rotate    - re-key anything still on the shipped default (--rotate-keys only)
//   3. add       - file whatever is left that isn't on record yet
// Reconcile must go first: an agent that merely moved is not a new agent, and letting the
// add pass see it before its address is repaired files it a second time as "<name>-<octet>".
let sweeping = false;
async function sweep(rotateKeys) {
  if (sweeping) return;   // prevents concurrent execution if a sweep is already in progress
  sweeping = true;
  try {
    const found = await scanForAgents();
    await reconcileAgents(loadSetupConfig(), { rotate: rotateKeys, found });
    if (rotateKeys) {
      // Reconcile may have rewritten the file, so work from what is on disk now.
      const fresh = loadSetupConfig();
      if (await rotateConfiguredKeys(fresh)) saveConfig(fresh);
    }
    await searchAndAddAgents(rotateKeys, found);
  } finally {
    sweeping = false;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const rotateKeys = args.includes("--rotate-keys");
  let rescanMinutes = 60;
  const rescanIdx = args.indexOf("--rescan");
  if (rescanIdx !== -1 && rescanIdx + 1 < args.length) {
    rescanMinutes = parseInt(args[rescanIdx + 1], 10);
    if (isNaN(rescanMinutes)) rescanMinutes = 60;
  }
  // Only --http has a console anyone reads; under stdio the client owns the pipe, so the
  // setup narration is suppressed there (security warnings still print, always).
  SETUP_QUIET = !args.includes("--http");

  const firstRun = !fs.existsSync(SHARED_FILE);
  if (firstRun) note(`No ${SHARED_FILE} found - scanning the network for agents.`);
  // --no-scan disables the network sweep. However, if the config file is missing on the
  // first run, a scan is enforced to discover initial agents.
  if ((!args.includes("--no-scan") && rescanMinutes !== 0) || firstRun) {
    await sweep(rotateKeys);
  }
  if (!args.includes("--no-scan") && rescanMinutes > 0) {
    setInterval(() => { sweep(rotateKeys).catch((e) => note(`Sweep failed: ${e.message}`)); },
                rescanMinutes * 60 * 1000).unref();
  }

  const httpMode = args.includes("--http");
  // --http binds to all interfaces (LAN) by default; --local restricts it to loopback.
  // An explicit --host <ip> wins over both.
  let host = args.includes("--local") ? "127.0.0.1" : "0.0.0.0";
  if (args.includes("--host")) host = args[args.indexOf("--host") + 1];
  const port = args.includes("--port") ? parseInt(args[args.indexOf("--port") + 1], 10) : 8315;

  if (httpMode) runHttp(host, port);
  else runStdio();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

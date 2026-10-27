#!/usr/bin/env node
// mcp-bridge - an MCP server that controls one or more GPIO agents (Raspberry Pi,
// Pico W or ESP32) by calling their REST API over HTTP.
//
// This app acts as an API proxy. It routes tool calls to remote agents by name (from
// agents-config.json) using their `pi-gpio-api` / `pico-gpio-api` / `esp32-gpio-api`
// REST endpoints, forwarding the agent's own `Api-Key`. Run it over stdio (for local
// MCP clients like Claude Desktop) or over Streamable HTTP (for networked clients).

// This server implements the MCP protocol (JSON-RPC 2.0 over stdio or Streamable HTTP)
// using Node built-ins to provide a focused API surface: a handful of methods
// (initialize, tools/list, tools/call) and two transports.
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const dgram = require("dgram");
const net = require("net");
const readline = require("readline");
const { randomUUID, timingSafeEqual } = require("crypto");

// The value after a flag such as --port, or null when the flag is absent. A flag given
// without a value is a usage error, so the server exits instead of guessing.
function flagValue(flag) {
  const args = process.argv.slice(2);
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usageError(`${flag} needs a value`);
  return v;
}

// A flag value that must be a whole number in [min, max].
function intFlag(flag, fallback, min, max) {
  const v = flagValue(flag);
  if (v === null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) usageError(`${flag} must be a whole number from ${min} to ${max}, not '${v}'`);
  return n;
}

function usageError(msg) {
  console.error(`mcp-bridge: ${msg}`);
  process.exit(2);
}

// --- Where the config files live ---------------------------------------------------
// Everything lives in ~/.ctrlpi/ (or the folder specified by --config).
// Two files, both flat in that one directory:
//
//   agents-config.json  the SHARED agent list (name/ip/port/api_key/key_set/updated_at) -
//                       every ctrlpi project reads it and any of them may update it
//   mcp-config.json     only what this server owns: `mcp` (its own HTTP-mode key, plus the
//                       ip/port ctrlpi-lab records for it) and an optional agents
//                       whitelist/blacklist (see selectAgents below)
//
// Both files always sit together in the same directory.
function resolveConfigFile(fileName) {
  let dir = path.join(os.homedir(), ".ctrlpi");
  const custom = flagValue("--config");
  if (custom !== null) dir = path.resolve(custom);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
    console.error(`Could not create ${dir}: ${e.message}`);
  }
  return path.join(dir, fileName);
}

const CONFIG_FILE = resolveConfigFile("mcp-config.json");
const SHARED_FILE = path.join(path.dirname(CONFIG_FILE), "agents-config.json");
const HOMEBRIDGE_SHARED_FILE = "/var/lib/homebridge/ctrlpi-agents-config.json";
const DEFAULT_PORT = 8314; // default REST port for agents that don't specify one
const DEFAULT_AGENT_KEY = "your-secret-key"; // the agents' shipped default Api-Key
const DEFAULT_HTTP_KEY = "your-mcp-key"; // this server's own default key, gating --http mode
const MAX_BODY_BYTES = 64 * 1024; // largest --http request body, else 413 (a full Pi config is under 5 KB)
const HTTP_TIMEOUT = 20000; // per-call timeout when proxying to an agent (ms)
const PROBE_TIMEOUT = 3000; // shorter timeout for liveness/type probes in agents_list (ms)
const SWEEP_MINUTES = 60;   // default minutes between background LAN sweeps (--rescan <n>)
const SCAN_TIMEOUT = 1500; // /hello timeout during a /24 sweep - a Zero 2 W or a Pico often
                           // misses a shorter window, and an agent the scan misses is one
                           // this server never sees
const SCAN_BATCH = 48;     // hosts probed at once; a Pico serves one connection at a time and
                           // drops probes when the whole /24 is fired simultaneously

// --- Discovery: sweep the LAN for agents and keep agents-config.json current ---

function localIp() {
  return new Promise((resolve) => {
    const fallback = () => {
      try {
        const ifaces = os.networkInterfaces();
        for (const name of Object.keys(ifaces)) {
          for (const iface of ifaces[name] || []) {
            if ((iface.family === "IPv4" || iface.family === 4) && !iface.internal && iface.address && !iface.address.startsWith("127.")) {
              return resolve(iface.address);
            }
          }
        }
      } catch { /* ignore */ }
      resolve(null);
    };

    const s = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      try { s.close(); } catch { /* ignore */ }
      fallback();
    }, 500);

    s.once("error", () => {
      clearTimeout(timer);
      try { s.close(); } catch { /* ignore */ }
      fallback();
    });

    try {
      s.connect(80, "8.8.8.8", () => {
        clearTimeout(timer);
        try {
          const ip = s.address().address;
          s.close();
          if (ip && ip !== "0.0.0.0" && !ip.startsWith("127.")) return resolve(ip);
        } catch {
          try { s.close(); } catch { /* ignore */ }
        }
        fallback();
      });
    } catch {
      clearTimeout(timer);
      try { s.close(); } catch { /* ignore */ }
      fallback();
    }
  });
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
  // One unauthenticated /hello. Returns {ip, port, name} or null. /hello needs no key, so this
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
  // Probe every host on the local /24 for an unauthenticated /hello.
  // Returns [{ip, name, port}, ...].
  // MCP_BRIDGE_SCAN_LAN=0 limits the sweep to the localhost mock agents (used by the tests).
  const ip = process.env.MCP_BRIDGE_SCAN_LAN === "0" ? null : await localIp();
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
function nowStamp(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
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
    // irreversible (the new key exists only in agents-config.json) and must always be asked for.
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
  note(`    already has its own key, which this app cannot read - set api_key in agents-config.json`);
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
      a.updated_at = nowStamp();
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
         `Its address could not be reconciled; check agents-config.json.`);
  }
  if (!toAdd.length) {
    if (!sameName.length) {
      note(agents.length ? "No new agents found." : "No agents found. You can add them later by editing agents-config.json.");
    }
  } else {
    note(`Found ${toAdd.length} new agent(s):`);
    for (const { ip, port, name } of toAdd) {
      knownNames.add(name);
      note(`  ${name} (${ip}:${port || DEFAULT_PORT})`);
      const key = await resolveAgentKey(ip, port || DEFAULT_PORT, rotateKeys);
      agents.push({ name, ip, port: port || DEFAULT_PORT, ...key, updated_at: nowStamp() });
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
  // Runs on every sweep that has agents configured: agents take new DHCP leases (a Pico
  // nearly always does on reset), so an IP in agents-config.json goes stale without anything
  // being wrong. Sweeps the LAN and repairs entries whose agent simply moved. Adds
  // nothing - the add pass in sweep() does that. Returns true if agents-config.json was rewritten.
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
    if (claimants.length === 1 && claimants[0].ip === a.ip &&
        (claimants[0].port || DEFAULT_PORT) === port) continue;          // where we left it

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
                      `leaving it alone; fix agents-config.json by hand.`);
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
    a.updated_at = nowStamp();
    changed = true;
  }

  // After all moves are settled, if any agent is currently active on an endpoint,
  // ensure no OTHER agent in agents-config.json is still claiming that endpoint.
  // This clears stale IPs from agents that went offline and whose lease was taken by someone else.
  for (const c of found) {
    const cEndpoint = `${c.ip}:${c.port || DEFAULT_PORT}`;
    for (const a of agents) {
      if (a.ip && `${a.ip}:${a.port || DEFAULT_PORT}` === cEndpoint && a.name !== c.name) {
        note(`Clearing stale IP ${a.ip} from '${a.name}' (now occupied by live agent '${c.name}').`);
        a.ip = "";
        a.updated_at = nowStamp();
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

function reconcileAgentList(baseAgents, overlayAgents) {
  const list = Array.isArray(baseAgents) ? [...baseAgents] : [];
  if (!Array.isArray(overlayAgents)) return list;
  for (const overlay of overlayAgents) {
    if (!overlay || !overlay.name) continue;
    const idx = list.findIndex((a) => a && a.name === overlay.name);
    if (idx === -1) {
      list.push({ ...overlay });
    } else {
      const existing = list[idx];
      const overlayDate = overlay.updated_at || "";
      const existingDate = existing.updated_at || "";
      if (overlayDate > existingDate) {
        list[idx] = { ...existing, ...overlay };
      }
    }
  }
  return list;
}

const loadOwn = () => readJsonFile(CONFIG_FILE);
const loadSharedAgents = () => {
  const shared = readJsonFile(SHARED_FILE);
  let list = Array.isArray(shared.agents) ? shared.agents : [];
  if (fs.existsSync(HOMEBRIDGE_SHARED_FILE)) {
    const hb = readJsonFile(HOMEBRIDGE_SHARED_FILE);
    if (Array.isArray(hb.agents)) {
      list = reconcileAgentList(list, hb.agents);
    }
  }
  return list;
};

// The shared agents-config.json is the only place agents are defined. This server's own file may
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

  let shared = readJsonFile(SHARED_FILE);
  if (!shared || typeof shared !== "object" || Array.isArray(shared)) shared = {};
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

// Agent names match case-insensitively everywhere a tool names an agent.
function sameName(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function findAgent(name) {
  return agents().find((a) => sameName(a.name, name)) || null;
}

// Copy a name or key the agent just accepted into the shared file, so the next call still
// reaches it. Waits for a running sweep first, so the sweep cannot save over this change.
async function syncAgentEntry(agentName, { name, api_key } = {}) {
  await settleSweep();
  const config = loadSetupConfig();
  const a = (config.agents || []).find((x) => sameName(x.name, agentName));
  if (!a) return;
  let updated = false;
  if (typeof name === "string" && name && name !== a.name) {
    a.name = name;
    updated = true;
  }
  if (typeof api_key === "string" && api_key !== a.api_key) {
    a.api_key = api_key;
    a.key_set = nowStamp();
    updated = true;
  }
  if (updated || !a.updated_at) {
    a.updated_at = nowStamp();
    saveConfig(config);
  }
}

function baseUrl(agent) {
  return `http://${agent.ip}:${agent.port || DEFAULT_PORT}`;
}

async function callAgent(agentName, method, path_, jsonBody = undefined, timeoutMs = HTTP_TIMEOUT) {
  // Proxy an HTTP call to the named agent. Returns [textResult, errorString];
  // exactly one is non-null.
  let agent = findAgent(agentName);
  if (!agent && sweepPromise) {
    // The background sweep may be about to file it (always the case on a first run).
    await settleSweep();
    agent = findAgent(agentName);
  }
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

// Keys, names, URLs and scripts are text: a number an MCP client sends for one goes to the
// agent as text (4242 -> "4242").
function asText(v) {
  return typeof v === "number" ? String(v) : v;
}

// asText() on every text field of a whole agent config (for mcp_config_load).
function textFields(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cfg;
  const out = { ...cfg };
  for (const k of ["name", "api_key", "webhook_url", "webhook_key", "matter", "matter_key",
                   "homekit", "homekit_key", "homebridge", "homebridge_key"]) {
    if (k in out) out[k] = asText(out[k]);
  }
  for (const group of ["notifications", "bridges"]) {
    if (out[group] && typeof out[group] === "object") {
      out[group] = Object.fromEntries(Object.entries(out[group]).map(([f, v]) => [f, asText(v)]));
    }
  }
  for (const [section, field] of [["gpios", "name"], ["sensors", "script"]]) {
    if (out[section] && typeof out[section] === "object") {
      out[section] = Object.fromEntries(Object.entries(out[section]).map(([k, e]) =>
        [k, e && typeof e === "object" && field in e ? { ...e, [field]: asText(e[field]) } : e]));
    }
  }
  return out;
}

function coerceValue(v) {
  // Map a string write value onto what the REST API expects (int, or one of the
  // word forms 'on'/'off'/'toggle').
  const s = String(v).trim().toLowerCase();
  if (s === "toggle" || s === "on" || s === "off") return s;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return v;
}

// Live status of one configured agent for mcp_agents_list: /hello, then /config/read for
// the version and type.
async function probeAgent(a) {
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
          const ai = info.agent || {};
          entry.version = ai.version ?? null;
          const plat = String(ai.platform || "").toLowerCase();
          // "pico" is tested first because it also begins with "pi".
          if (plat.includes("pico")) entry.type = "pico";
          else if (plat.includes("esp32")) entry.type = "esp32";
          else if (plat.split(/\s+/)[0] === "pi" || plat.includes("raspberry pi")) entry.type = "pi";
          else if (plat) entry.type = plat;
        }
      } catch {
        // leave version/type at defaults
      }
    }
  }
  return entry;
}

// --- MCP tools ---

// A tool's MCP result: the agent's answer, or the error text flagged with isError.
function toolResult(result, err) {
  return err ? { content: [{ type: "text", text: err }], isError: true }
             : { content: [{ type: "text", text: result }] };
}

// Each tool is { name, description, inputSchema, handler }. `inputSchema` is a plain
// JSON Schema object (draft-07 style). `handler(args)` receives the call's `arguments`
// object and returns an MCP tool result ({ content: [{ type: "text", text }] }).
const TOOLS = [
  {
    name: "mcp_agents_list",
    description:
      "List configured agents (Pi, Pico or ESP32). Returns name, ip, port, online (live /hello probe), " +
      "type (pi/pico/esp32), version, has_default_key, and last_updated_at (UTC \"YYYY-MM-DD HH:MM:SS\", " +
      "when the agent list was last saved; every sweep saves it). Unreachable agents are included " +
      "(online=false). The LAN is swept automatically every hour. Pass rescan=true to sweep it now, " +
      "but only when the user asks to find new hardware: a sweep takes 10 seconds or more. " +
      "If has_default_key is true for any agent, tell the user that agent is on the insecure " +
      "default key and ask whether to change it.",
    inputSchema: {
      type: "object",
      properties: { rescan: { type: "boolean" } },
    },
    handler: async ({ rescan }) => {
      // An explicit rescan runs even under --no-scan; otherwise wait out a sweep in progress.
      if (rescan) {
        try {
          await sweep();
        } catch (e) {
          return toolResult(null, `Error: rescan failed: ${e.message}`);
        }
      } else {
        await settleSweep();
      }
      // Probed all at once, so offline agents cost one timeout in total, not one each.
      const out = await Promise.all(agents().map(probeAgent));
      let last_updated_at = null;
      try {
        last_updated_at = nowStamp(fs.statSync(SHARED_FILE).mtime);
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
      return toolResult(result, err);
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
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_gpio_scan",
    description:
      "Scan all hardware GPIO pins on `agent` and return each pin's level (the physical state), " +
      "type, pull resistor and name; a reversed pin also reports `value` (its logical state) and " +
      "`reversed`. Pins: BCM 2-27 on a Raspberry Pi, GP0-GP28 (minus the WiFi-reserved GP23/24/25/29) " +
      "on a Pico, and every usable pin of the chip on an ESP32 (flash, PSRAM and USB pins are left out).",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/gpio/scan");
      return toolResult(result, err);
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
      if (name !== undefined) body.name = asText(name);
      if (type !== undefined) body.type = type;
      if (init !== undefined) body.init = /^-?\d+$/.test(init) ? parseInt(init, 10) : init;
      if (pullup !== undefined) body.pullup = pullup;
      if (max !== undefined) body.max = max;
      if (reversed !== undefined) body.reversed = reversed;
      if (watched !== undefined) body.watched = watched;
      const [result, err] = await callAgent(agent, "POST", `/gpio/config/${gpio}`, body);
      return toolResult(result, err);
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
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_sensor_config",
    description:
      "Configure a named sensor on `agent`. A sensor runs a script and its output is the " +
      "reading. `script` is \"<script-file> [args...]\": a bare filename in the agent's " +
      "scripts/ folder (no paths - that folder is the only allowed location), with " +
      "letters/digits-only arguments. On a Raspberry Pi it is a shell script run with `sh`; " +
      "on a Pico or ESP32 a .py file the agent execs in-process. Pass remove=true to delete the sensor.",
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
      if (script !== undefined) body.script = asText(script);
      if (remove !== undefined) body.remove = remove;
      const [result, err] = await callAgent(agent, "POST", `/sensor/config/${name}`, body);
      return toolResult(result, err);
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
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_script_list",
    description:
      "List the files in `agent`'s scripts/ folder (the folder sensors run from): `scripts` " +
      "([{name, size, modified}]) and `write`: \"enabled\", \"default_key\" (writes are refused " +
      "until the agent's api_key is changed from the default) or \"locked\" (a write.lock file " +
      "there blocks every write).",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/script/list");
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_script_read",
    description: "Read one file from `agent`'s scripts/ folder. Returns {name, content}.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, name: { type: "string" } },
      required: ["agent", "name"],
    },
    handler: async ({ agent, name }) => {
      const [result, err] = await callAgent(agent, "GET", `/script/read/${encodeURIComponent(name)}`);
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_script_write",
    description:
      "Create or overwrite a file in `agent`'s scripts/ folder with `content`, or delete it with " +
      "remove=true. `name` is a bare filename of up to 32 characters (letters, digits, . _ -, no " +
      "leading dot or dash, no paths). Refused while the agent still has the default api_key, and " +
      "once a write.lock file is in the folder. Writing write.lock (any content) locks every script " +
      "write, and this tool can then no longer change or remove it. The lock does not stop runs: " +
      "a script run with mcp_script_run that deletes files can remove write.lock, as can a shell " +
      "(Pi) or USB (Pico, ESP32).",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        remove: { type: "boolean" },
      },
      required: ["agent", "name"],
    },
    handler: async ({ agent, name, content, remove }) => {
      const body = {};
      if (content !== undefined) body.content = asText(content);
      if (remove !== undefined) body.remove = remove;
      const [result, err] = await callAgent(agent, "POST", `/script/write/${encodeURIComponent(name)}`, body);
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_script_run",
    description:
      "Run a file from `agent`'s scripts/ folder and return {name, exit_code, output}. On a " +
      "Raspberry Pi a .py runs with the agent's Python and anything else with `sh`; output is its " +
      "stdout (first 2 KB) and a run over 15 s is killed. On a Pico or ESP32 the file is exec'd " +
      "in-process: output is what its read(*args) returns, or its `result`, and exit_code is 1 if it " +
      "raised. `args` are letters and digits only.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string" },
        name: { type: "string" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["agent", "name"],
    },
    handler: async ({ agent, name, args }) => {
      const body = args !== undefined ? { args: Array.isArray(args) ? args.map(asText) : args } : undefined;
      const [result, err] = await callAgent(agent, "POST", `/script/run/${encodeURIComponent(name)}`, body);
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_config_read",
    description:
      "Read `agent`'s global application configuration, grouped: `notifications` (`webhook` " +
      "+ `webhook_key`), `bridges` (matter/homekit/homebridge callbacks), `settings` (docs_enabled, logs_enabled, " +
      "log_days), `sensors`, and configured pins (`gpios`). The `agent` block (platform, os, " +
      "ip, cpu_temperature, version) is computed live on every read and is not stored.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "GET", "/config/read");
      return toolResult(result, err);
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
      "the local agents-config.json file to match automatically.",
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
      if (name !== undefined) body.name = asText(name);
      if (api_key !== undefined) body.api_key = asText(api_key);
      if (webhook_url !== undefined) body.webhook_url = asText(webhook_url);
      if (webhook_key !== undefined) body.webhook_key = asText(webhook_key);
      if (docs_enabled !== undefined) body.docs_enabled = docs_enabled;
      if (logs_enabled !== undefined) body.logs_enabled = logs_enabled;
      if (log_days !== undefined) body.log_days = log_days;
      const [result, err] = await callAgent(agent, "POST", "/config/update", body);
      if (!err) await syncAgentEntry(agent, { name: body.name, api_key: body.api_key });
      return toolResult(result, err);
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
    handler: async ({ agent, config: raw }) => {
      const config = textFields(raw);
      const [result, err] = await callAgent(agent, "POST", "/config/load", config);
      // A loaded name or api_key replaces the agent's own, so record them like mcp_config_write.
      if (!err && config && typeof config === "object") {
        await syncAgentEntry(agent, { name: config.name, api_key: config.api_key });
      }
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_agent_restart",
    description:
      "Restart `agent`'s server process. Pass reboot=true to reboot the whole device instead " +
      "(a Pi, Pico or ESP32); an agent running on a Mac ignores it and restarts the process.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" }, reboot: { type: "boolean" } },
      required: ["agent"],
    },
    handler: async ({ agent, reboot }) => {
      const [result, err] = await callAgent(agent, "POST", "/restart", { reboot: !!reboot });
      return toolResult(result, err);
    },
  },
  {
    name: "mcp_agent_upgrade",
    description:
      "Upgrade `agent` to the latest release, then restart it. A Pi runs `install.sh --upgrade` " +
      "(re-downloads the release files and reinstalls dependencies); a Pico or ESP32 downloads " +
      "the new files over WiFi, swaps them in and resets.",
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string" } },
      required: ["agent"],
    },
    handler: async ({ agent }) => {
      const [result, err] = await callAgent(agent, "POST", "/upgrade");
      return toolResult(result, err);
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
      return toolResult(result, err);
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
  // stdin closed: finish the requests already read, then exit.
  rl.on("close", () => { chain.then(() => process.exit(0)); });
}

// --- Streamable HTTP transport ---

// Constant-time comparison to prevent timing attacks.
function keysMatch(provided, expected) {
  const a = Buffer.from(String(provided ?? ""), "utf8");
  const b = Buffer.from(String(expected ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkApiKey(req, apiKey) {
  // Gates the Streamable HTTP transport on the Api-Key header.
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

// Blocks DNS rebinding: a web page on a domain that resolves to this host reaches /mcp
// as same-origin, so a browser request is accepted only from a localhost or IP-address
// origin. MCP clients that are not browsers send no Origin header and always pass.
function originAllowed(origin) {
  if (origin === undefined) return true;
  let host;
  try { host = new URL(origin).hostname; } catch { return false; }
  host = host.replace(/^\[|\]$/g, "");
  return host === "localhost" || net.isIP(host) !== 0;
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
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname !== "/mcp" && pathname !== "/mcp/") {
      res.writeHead(404).end();
      return;
    }
    if (!originAllowed(req.headers.origin)) {
      sendJson(res, 403, { error: "Origin not allowed" });
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
  server.on("error", (e) => {
    const why = e.code === "EADDRINUSE" ? `port ${port} is already in use` : e.message;
    console.error(`mcp-bridge: cannot listen on ${host}:${port}: ${why}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`INFO:     mcp-bridge Streamable HTTP at http://${host}:${port}/mcp`);
  });
}

const ROTATE_KEYS = process.argv.slice(2).includes("--rotate-keys");
let sweepPromise = null;   // the sweep in progress, if any

// Starts a sweep, or joins the one already running.
function sweep() {
  if (!sweepPromise) {
    sweepPromise = runSweep(ROTATE_KEYS).finally(() => { sweepPromise = null; });
  }
  return sweepPromise;
}

// Waits for a sweep in progress to finish; its failure is logged where it ran.
async function settleSweep() {
  if (sweepPromise) await sweepPromise.catch(() => {});
}

// One LAN sweep feeding every pass, in the order they have to run:
//   1. reconcile - repair the address of an agent that took a new DHCP lease
//   2. rotate    - re-key anything still on the shipped default (--rotate-keys only)
//   3. add       - file whatever is left that isn't on record yet
// Reconcile must go first: an agent that merely moved is not a new agent, and letting the
// add pass see it before its address is repaired files it a second time as "<name>-<octet>".
async function runSweep(rotateKeys) {
  const found = await scanForAgents();
  await reconcileAgents(loadSetupConfig(), { rotate: rotateKeys, found });
  if (rotateKeys) {
    // Reconcile may have rewritten the file, so work from what is on disk now.
    const fresh = loadSetupConfig();
    if (await rotateConfiguredKeys(fresh)) saveConfig(fresh);
  }
  await searchAndAddAgents(rotateKeys, found);
}

async function main() {
  const args = process.argv.slice(2);
  // Read every flag first, so a usage error exits before anything starts.
  const rescanMinutes = intFlag("--rescan", SWEEP_MINUTES, 0, 10080);
  const httpMode = args.includes("--http");
  // --http binds to all interfaces (LAN) by default; --local restricts it to loopback.
  // An explicit --host <ip> wins over both.
  const host = flagValue("--host") ?? (args.includes("--local") ? "127.0.0.1" : "0.0.0.0");
  const port = intFlag("--port", 8315, 1, 65535);
  // Only --http has a console anyone reads; under stdio the client owns the pipe, so the
  // setup narration is suppressed there (security warnings still print, always).
  SETUP_QUIET = !args.includes("--http");

  // The sweep runs in the background, so the transport answers at once; a tool that needs
  // an agent the sweep has not filed yet waits for it (see callAgent and mcp_agents_list).
  // --no-scan or --rescan 0 turns the automatic sweeps off, except on a first run.
  const autoScan = !args.includes("--no-scan") && rescanMinutes > 0;
  const firstRun = !fs.existsSync(SHARED_FILE);
  if (firstRun) note(`No ${SHARED_FILE} found - scanning the network for agents.`);
  const logFailure = (e) => note(`Sweep failed: ${e.message}`);
  if (autoScan || firstRun) sweep().catch(logFailure);
  if (autoScan) setInterval(() => sweep().catch(logFailure), rescanMinutes * 60 * 1000).unref();

  if (httpMode) runHttp(host, port);
  else runStdio();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

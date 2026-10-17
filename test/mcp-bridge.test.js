'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { after, before, describe, test } = require('node:test');

const PROJECT_DIR = path.resolve(__dirname, '..');
const TMP_CONFIG = path.join(__dirname, 'tmp-config');
const AGENT_SCRIPT = path.join(PROJECT_DIR, 'mock_agent.py');
const SERVER_SCRIPT = path.join(PROJECT_DIR, 'server.js');

const HTTP_PORT = 18315;   // off the ctrlPi default ports, so a running bridge can't collide
const AGENT1_PORT = 8081;
const AGENT2_PORT = 8082;
const AGENT_KEY = 'your-secret-key';
const MCP_KEY = 'test-mcp-key';

let agent1Proc;
let agent2Proc;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAgent(port, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/hello`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await sleep(50);
  }
  throw new Error(`Mock agent on port ${port} failed to start within ${timeoutMs}ms`);
}

before(async () => {
  fs.mkdirSync(TMP_CONFIG, { recursive: true });
  fs.writeFileSync(path.join(TMP_CONFIG, 'agents-config.json'), JSON.stringify({
    agents: [
      { name: 'mock-pi', ip: '127.0.0.1', port: AGENT1_PORT, api_key: AGENT_KEY },
      { name: 'mock-pico', ip: '127.0.0.1', port: AGENT2_PORT, api_key: AGENT_KEY }
    ]
  }));
  fs.writeFileSync(path.join(TMP_CONFIG, 'mcp-config.json'), JSON.stringify({
    mcp: { api_key: MCP_KEY }
  }));

  agent1Proc = spawn('python3', [AGENT_SCRIPT, '--port', AGENT1_PORT, '--name', 'mock-pi', '--type', 'pi'], { stdio: 'ignore' });
  agent2Proc = spawn('python3', [AGENT_SCRIPT, '--port', AGENT2_PORT, '--name', 'mock-pico', '--type', 'pico'], { stdio: 'ignore' });

  // Wait for both mock agents to be ready
  await Promise.all([
    waitForAgent(AGENT1_PORT),
    waitForAgent(AGENT2_PORT)
  ]);
});

after(() => {
  if (agent1Proc) agent1Proc.kill();
  if (agent2Proc) agent2Proc.kill();
  fs.rmSync(TMP_CONFIG, { recursive: true, force: true });
});

class HttpClient {
  constructor({ port = HTTP_PORT, config = TMP_CONFIG, args = ['--no-scan'], key = MCP_KEY, env = {} } = {}) {
    this.port = port;
    this.env = env;
    this.config = config;
    this.args = args;
    this.endpoint = `http://127.0.0.1:${port}/mcp`;
    this.headers = {
      'Content-Type': 'application/json',
      'Api-Key': key
    };
    this.proc = null;
  }

  // Resolves once the server listens. Probes a non-/mcp path, which needs no key, so the
  // probe can never claim the HTTP key on a fresh config.
  async listen() {
    this.proc = spawn('node', [SERVER_SCRIPT, '--http', '--port', String(this.port), '--config', this.config, ...this.args], { stdio: 'inherit', env: { ...process.env, ...this.env } });
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        await fetch(`http://127.0.0.1:${this.port}/`);
        return;
      } catch {
        await sleep(50);
      }
    }
    throw new Error(`mcp-bridge on port ${this.port} failed to start`);
  }

  async start() {
    await this.listen();
    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    this.headers['Mcp-Session-Id'] = 'test-session';
    await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
  }

  async request(method, params, id = 1) {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
    return json;
  }

  async listTools() {
    const res = await this.request('tools/list', {}, 2);
    return res.result.tools;
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args }, 3);
    return res.result;
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

class StdioClient {
  constructor() {
    this.proc = null;
    this.id = 0;
    this.pending = new Map();
  }

  async start() {
    this.proc = spawn('node', [SERVER_SCRIPT, '--config', TMP_CONFIG, '--no-scan'], { stdio: ['pipe', 'pipe', 'inherit'] });
    
    this.proc.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && this.pending.has(msg.id)) {
            const { resolve, reject } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg);
          }
        } catch (e) {
          // ignore parse errors
        }
      }
    });

    const init = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    });
    this.notify('notifications/initialized', {});
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => reject(new Error('timeout')), 5000);
    });
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return res.result.tools;
  }

  async callTool(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    return res.result;
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

const STAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;   // UTC "YYYY-MM-DD HH:MM:SS"

// The entry the bridge saved for `name` in a config folder's agents-config.json.
function storedAgent(name, dir = TMP_CONFIG) {
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'agents-config.json'), 'utf8'));
  return (file.agents || []).find(a => a.name === name);
}

function parseToolResult(result) {
  if (!result || !result.content || !result.content[0]) return null;
  const text = result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function runTestSet(client) {
  before(async () => {
    await client.start();
  });
  
  after(() => {
    client.stop();
  });
  
  test('tools list', async () => {
    const tools = await client.listTools();
    const names = tools.map(t => t.name);
    assert.ok(names.includes('mcp_agents_list'));
    assert.ok(names.includes('mcp_gpio_read'));
    assert.ok(names.includes('mcp_gpio_write'));
  });

  test('agents list', async () => {
    const res = await client.callTool('mcp_agents_list', {});
    const data = parseToolResult(res);
    assert.ok(Array.isArray(data.agents));
    assert.equal(data.agents.length, 2);
    
    const pi = data.agents.find(a => a.name === 'mock-pi');
    assert.equal(pi.online, true);
    assert.equal(pi.type, 'pi');
    
    const pico = data.agents.find(a => a.name === 'mock-pico');
    assert.equal(pico.online, true);
    assert.equal(pico.type, 'pico');
  });

  test('unknown agent', async () => {
    const res = await client.callTool('mcp_gpio_read', { agent: 'fake-agent', name_or_gpio: 'all' });
    const text = parseToolResult(res);
    assert.match(String(text), /unknown agent/i);
    assert.equal(res.isError, true);
  });

  // Tests per agent
  for (const agent of ['mock-pi', 'mock-pico']) {
    test(`[${agent}] config read`, async () => {
      const res = await client.callTool('mcp_config_read', { agent });
      const data = parseToolResult(res);
      assert.ok(data.agent.version);
      assert.ok(data.gpios);
    });

    test(`[${agent}] gpio config`, async () => {
      const res = await client.callTool('mcp_gpio_config', { agent, gpio: '26', type: 'output', name: 'test_pin' });
      const text = parseToolResult(res);
      assert.doesNotMatch(String(text), /error/i);
      
      const cfgRes = await client.callTool('mcp_config_read', { agent });
      const cfg = parseToolResult(cfgRes);
      assert.ok(cfg.gpios['26']);
    });

    test(`[${agent}] gpio read/write`, async () => {
      await client.callTool('mcp_gpio_write', { agent, name_or_gpio: '26', value: '1' });
      let readRes = await client.callTool('mcp_gpio_read', { agent, name_or_gpio: '26' });
      assert.equal(parseToolResult(readRes).value, 1);
      
      await client.callTool('mcp_gpio_write', { agent, name_or_gpio: '26', value: '0' });
      readRes = await client.callTool('mcp_gpio_read', { agent, name_or_gpio: '26' });
      assert.equal(parseToolResult(readRes).value, 0);
    });
    
    test(`[${agent}] gpio scan`, async () => {
      const res = await client.callTool('mcp_gpio_scan', { agent });
      const data = parseToolResult(res);
      assert.ok(Array.isArray(data));
      assert.equal(data[0].gpio, '26');
    });

    test(`[${agent}] sensor json nesting`, async () => {
      await client.callTool('mcp_sensor_config', { agent, name: 'weather', script: 'sensor-json.sh' });
      await client.callTool('mcp_sensor_config', { agent, name: 'stats', script: 'sensor-multi.sh' });
      
      let res = await client.callTool('mcp_sensor_read', { agent, name: 'weather' });
      assert.deepEqual(parseToolResult(res), { weather: 1013 });
      
      res = await client.callTool('mcp_sensor_read', { agent, name: 'stats' });
      assert.deepEqual(parseToolResult(res), { stats: { cpu: 12, mem: 48 } });
      
      await client.callTool('mcp_sensor_config', { agent, name: 'weather', remove: true });
      await client.callTool('mcp_sensor_config', { agent, name: 'stats', remove: true });
    });

    test(`[${agent}] sensor bare value`, async () => {
      await client.callTool('mcp_sensor_config', { agent, name: 'level', script: 'sensor-value.sh' });
      let res = await client.callTool('mcp_sensor_read', { agent, name: 'level' });
      assert.deepEqual(parseToolResult(res), { level: 42 });
      await client.callTool('mcp_sensor_config', { agent, name: 'level', remove: true });
    });
    
    test(`[${agent}] sensor read-all`, async () => {
      await client.callTool('mcp_sensor_config', { agent, name: 'level', script: 'sensor-value.sh' });
      await client.callTool('mcp_sensor_config', { agent, name: 'stats', script: 'sensor-multi.sh' });
      
      let res = await client.callTool('mcp_sensor_read', { agent });
      const data = parseToolResult(res);
      assert.equal(data.level, 42);
      assert.deepEqual(data.stats, { cpu: 12, mem: 48 });
      
      await client.callTool('mcp_sensor_config', { agent, name: 'level', remove: true });
      await client.callTool('mcp_sensor_config', { agent, name: 'stats', remove: true });
    });
    
    test(`[${agent}] sensor remove`, async () => {
      await client.callTool('mcp_sensor_config', { agent, name: 'level', script: 'sensor-value.sh' });
      await client.callTool('mcp_sensor_config', { agent, name: 'level', remove: true });
      let res = await client.callTool('mcp_config_read', { agent });
      const data = parseToolResult(res);
      assert.ok(!data.sensors || !data.sensors.level);
    });

    test(`[${agent}] key rotation`, async () => {
      const newKey = `test-key-${Date.now()}`;
      // 1. Rotate to a new key
      await client.callTool('mcp_config_write', { agent, api_key: newKey });
      
      // 2. Subsequent call should succeed because mcp-bridge auto-saves the new key
      const res = await client.callTool('mcp_gpio_read', { agent, name_or_gpio: 'all' });
      assert.doesNotMatch(String(parseToolResult(res)), /403/);
      
      // 3. Rotate it back to the original default key
      await client.callTool('mcp_config_write', { agent, api_key: AGENT_KEY });
      
      // 4. Verify it works again with the restored key
      const verifyRes = await client.callTool('mcp_gpio_read', { agent, name_or_gpio: 'all' });
      assert.doesNotMatch(String(parseToolResult(verifyRes)), /error/i);
    });

    test(`[${agent}] gpio watched`, async () => {
      const res = await client.callTool('mcp_gpio_watched', { agent });
      const data = parseToolResult(res);
      assert.ok(Array.isArray(data.watched));
    });

    test(`[${agent}] agent upgrade`, async () => {
      const res = await client.callTool('mcp_agent_upgrade', { agent });
      const data = parseToolResult(res);
      assert.equal(data.status, 'upgrading');
    });

    test(`[${agent}] key change is saved under any name case`, async () => {
      const newKey = `case-key-${Date.now()}`;
      await client.callTool('mcp_config_write', { agent: agent.toUpperCase(), api_key: newKey });
      assert.equal(storedAgent(agent).api_key, newKey);
      assert.match(storedAgent(agent).key_set, STAMP);
      const res = await client.callTool('mcp_gpio_read', { agent, name_or_gpio: 'all' });
      assert.doesNotMatch(String(parseToolResult(res)), /error/i);
      await client.callTool('mcp_config_write', { agent, api_key: AGENT_KEY });
      assert.equal(storedAgent(agent).api_key, AGENT_KEY);
    });

    test(`[${agent}] a numeric key is sent and saved as text`, async () => {
      await client.callTool('mcp_config_write', { agent, api_key: 4242 });
      assert.equal(storedAgent(agent).api_key, '4242');
      let res = await client.callTool('mcp_config_read', { agent });
      assert.ok(!res.isError, 'agent reachable on "4242"');
      await client.callTool('mcp_config_load', { agent, config: { api_key: 5151 } });
      assert.equal(storedAgent(agent).api_key, '5151');
      res = await client.callTool('mcp_config_read', { agent });
      assert.ok(!res.isError, 'agent reachable on "5151"');
      await client.callTool('mcp_config_write', { agent, api_key: AGENT_KEY });
      assert.equal(storedAgent(agent).api_key, AGENT_KEY);
    });

    test(`[${agent}] config load keeps the stored key in sync`, async () => {
      const newKey = `load-key-${Date.now()}`;
      await client.callTool('mcp_config_load', { agent, config: { api_key: newKey } });
      assert.equal(storedAgent(agent).api_key, newKey);
      let res = await client.callTool('mcp_config_read', { agent });
      assert.ok(parseToolResult(res).agent, 'agent reachable on the loaded key');

      // A config without api_key keeps the agent's key, so the stored one stays too.
      await client.callTool('mcp_config_load', { agent, config: {} });
      assert.equal(storedAgent(agent).api_key, newKey);
      res = await client.callTool('mcp_config_read', { agent });
      assert.ok(parseToolResult(res).agent, 'agent reachable after an empty load');

      await client.callTool('mcp_config_load', { agent, config: { api_key: AGENT_KEY } });
      assert.equal(storedAgent(agent).api_key, AGENT_KEY);
    });
  }
}

describe('Stdio Transport', () => {
  const client = new StdioClient();
  runTestSet(client);
});

describe('HTTP Transport', () => {
  const client = new HttpClient();
  runTestSet(client);
});

describe('HTTP auth', () => {
  const dir = path.join(__dirname, 'tmp-auth');
  const port = HTTP_PORT + 1;
  const server = new HttpClient({ port, config: dir });
  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  const post = (key, body = ping) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Api-Key': key } : {}) },
    body,
  });

  before(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    // An agent list but no mcp-config.json: the server starts on the default HTTP key.
    fs.writeFileSync(path.join(dir, 'agents-config.json'), JSON.stringify({ agents: [] }));
    await server.listen();
  });

  after(() => {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing key is refused', async () => {
    assert.equal((await post(null)).status, 403);
  });

  test('the default key works until a key is claimed', async () => {
    assert.equal((await post('your-mcp-key')).status, 200);
  });

  test('a browser on another domain is refused and cannot claim the key', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': 'evil-key', Origin: 'http://evil.example:18316' },
      body: ping,
    });
    assert.equal(res.status, 403);
    assert.equal(fs.existsSync(path.join(dir, 'mcp-config.json')), false);
  });

  test('a localhost browser origin is accepted', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Api-Key': 'your-mcp-key', Origin: 'http://localhost:6274' },
      body: ping,
    });
    assert.equal(res.status, 200);
  });

  test('the first other key claims it', async () => {
    assert.equal((await post('claimed-key')).status, 200);
    const own = JSON.parse(fs.readFileSync(path.join(dir, 'mcp-config.json'), 'utf8'));
    assert.equal(own.mcp.api_key, 'claimed-key');
    assert.match(own.mcp.key_set, STAMP);
  });

  test('after the claim only that key works', async () => {
    assert.equal((await post('your-mcp-key')).status, 403);
    assert.equal((await post('another-key')).status, 403);
    assert.equal((await post('claimed-key')).status, 200);
  });

  test('paths other than /mcp are 404', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/mcpx`, { method: 'POST' })).status, 404);
  });

  test('a body over 64 KB is 413', async () => {
    assert.equal((await post('claimed-key', 'x'.repeat(64 * 1024 + 1))).status, 413);
  });
});

describe('Discovery', () => {
  const dir = path.join(__dirname, 'tmp-discovery');
  const port = HTTP_PORT + 2;
  // Inside the 9314-9319 range the sweep checks on localhost for mock agents.
  const A = { name: 'disc-a', port: 9318, type: 'pi' };
  const B = { name: 'disc-b', port: 9319, type: 'Generic ESP32S3 module with ESP32-S3' };
  const env = { MCP_BRIDGE_SCAN_LAN: '0' };   // sweep the localhost mocks only, never the real /24
  let mocks = [];

  before(async () => {
    mocks = [A, B].map(m => spawn('python3', [AGENT_SCRIPT, '--port', m.port, '--name', m.name, '--type', m.type], { stdio: 'ignore' }));
    await Promise.all([waitForAgent(A.port), waitForAgent(B.port)]);
  });

  after(() => {
    mocks.forEach(p => p.kill());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a first run answers at once, then lists what the sweep found', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const client = new HttpClient({ port, config: dir, env });   // --no-scan: a first run sweeps anyway
    const t0 = Date.now();
    try {
      await client.start();
      assert.ok(Date.now() - t0 < 3000, 'initialize should not wait for the LAN sweep');
      const data = parseToolResult(await client.callTool('mcp_agents_list', {}));
      for (const m of [A, B]) {
        const e = data.agents.find(a => a.name === m.name);
        assert.ok(e, `${m.name} listed`);
        assert.equal(e.port, m.port);
        assert.equal(e.online, true);
      }
      // An ESP32 reports its board string as platform; it is listed as type esp32.
      assert.equal(data.agents.find(a => a.name === B.name).type, 'esp32');
      assert.match(data.last_updated_at, STAMP);
      assert.equal(storedAgent(A.name, dir).api_key, AGENT_KEY);
      assert.match(storedAgent(A.name, dir).updated_at, STAMP);
    } finally {
      client.stop();
    }
  });

  test('--no-scan sweeps nothing; rescan=true repairs a moved agent and adds new ones', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents-config.json'), JSON.stringify({
      agents: [{ name: A.name, ip: '127.0.0.1', port: 9399, api_key: AGENT_KEY }],
    }));
    const client = new HttpClient({ port, config: dir, env });
    try {
      await client.start();
      let data = parseToolResult(await client.callTool('mcp_agents_list', {}));
      assert.equal(data.agents.length, 1, 'no sweep under --no-scan');
      assert.equal(data.agents[0].port, 9399);
      assert.equal(data.agents[0].online, false);

      data = parseToolResult(await client.callTool('mcp_agents_list', { rescan: true }));
      const a = data.agents.filter(e => e.name.startsWith(A.name));
      assert.equal(a.length, 1, 'moved agent repaired, not filed twice');
      assert.equal(a[0].port, A.port);
      assert.equal(a[0].online, true);
      assert.ok(data.agents.find(e => e.name === B.name), 'new agent added');
    } finally {
      client.stop();
    }
  });
});

describe('Startup and shutdown', () => {
  const dir = path.join(__dirname, 'tmp-startup');

  before(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents-config.json'), JSON.stringify({
      // Unroutable addresses: each /hello probe runs into its 3 s timeout.
      agents: ['10.255.255.1', '10.255.255.2', '10.255.255.3'].map((ip, i) => ({ name: `dead-${i}`, ip, port: 8314, api_key: AGENT_KEY })),
    }));
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Runs the server to exit with `args` and `stdin` text; resolves { code, stdout, stderr }.
  function runServer(args, stdin = '') {
    return new Promise((resolve) => {
      const proc = spawn('node', [SERVER_SCRIPT, '--config', dir, '--no-scan', ...args]);
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('exit', code => resolve({ code, stdout, stderr }));
      proc.stdin.end(stdin);
    });
  }

  test('a flag without a valid value exits with code 2', async () => {
    let r = await runServer(['--http', '--port']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--port needs a value/);
    r = await runServer(['--http', '--port', 'abc']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--port must be a whole number/);
    r = await runServer(['--rescan', '-1']);
    assert.equal(r.code, 2);
  });

  test('a busy HTTP port exits with code 1 and a message', async () => {
    const busyPort = HTTP_PORT + 4;
    const blocker = require('node:http').createServer();
    await new Promise(resolve => blocker.listen(busyPort, '0.0.0.0', resolve));
    try {
      const r = await runServer(['--http', '--port', String(busyPort)]);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /^mcp-bridge: cannot listen on 0\.0\.0\.0:\d+: port \d+ is already in use$/m);
    } finally {
      blocker.close();
    }
  });

  test('a failed rescan comes back as an isError tool result', { skip: process.getuid && process.getuid() === 0 }, async () => {
    const roDir = path.join(__dirname, 'tmp-readonly');
    fs.rmSync(roDir, { recursive: true, force: true });
    fs.mkdirSync(roDir, { recursive: true });
    const file = path.join(roDir, 'agents-config.json');
    fs.writeFileSync(file, JSON.stringify({ agents: [] }));
    fs.chmodSync(file, 0o444);   // the sweep cannot save, so it fails
    const client = new HttpClient({ port: HTTP_PORT + 5, config: roDir, env: { MCP_BRIDGE_SCAN_LAN: '0' } });
    try {
      await client.start();
      const res = await client.callTool('mcp_agents_list', { rescan: true });
      assert.equal(res.isError, true);
      assert.match(parseToolResult(res), /rescan failed/);
    } finally {
      client.stop();
      fs.rmSync(roDir, { recursive: true, force: true });
    }
  });

  test('stdio answers requests already read before it exits', async () => {
    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'mcp_gpio_read', arguments: { agent: 'nobody', name_or_gpio: 'all' } } },
    ];
    const r = await runServer([], msgs.map(m => JSON.stringify(m)).join('\n') + '\n');
    assert.equal(r.code, 0);
    const ids = r.stdout.trim().split('\n').map(l => JSON.parse(l).id);
    assert.deepEqual(ids, [1, 2]);
  });

  test('offline agents are probed at once, not one after another', async () => {
    const client = new HttpClient({ port: HTTP_PORT + 3, config: dir });
    try {
      await client.start();
      const t0 = Date.now();
      const data = parseToolResult(await client.callTool('mcp_agents_list', {}));
      assert.equal(data.agents.length, 3);
      assert.ok(data.agents.every(a => a.online === false));
      assert.ok(Date.now() - t0 < 6000, 'three 3 s timeouts should overlap');
    } finally {
      client.stop();
    }
  });
});

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

const HTTP_PORT = 8316;
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
  fs.writeFileSync(path.join(TMP_CONFIG, 'config.json'), JSON.stringify({
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
  constructor() {
    this.endpoint = `http://127.0.0.1:${HTTP_PORT}/mcp`;
    this.headers = {
      'Content-Type': 'application/json',
      'Api-Key': MCP_KEY
    };
    this.proc = null;
  }

  async start() {
    this.proc = spawn('node', [SERVER_SCRIPT, '--http', '--port', String(HTTP_PORT), '--config', TMP_CONFIG, '--no-scan'], { stdio: 'inherit' });
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        await fetch(this.endpoint, { method: 'POST', headers: this.headers, body: '{}' });
        break;
      } catch {
        await sleep(50);
      }
    }

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

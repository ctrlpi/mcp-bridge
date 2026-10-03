# Bridge Testing Playbook

This document outlines the zero-dependency integration testing architecture used in `mcp-bridge`. It serves as a blueprint for implementing identical test environments across other bridges (e.g., `homebridge`, `homekit`, `matter`).

## Architecture Principles

1. **Zero External Dependencies**: We use the native Node.js (`>=20`) test runner (`node:test`) and native Python 3 (`http.server`) to minimize dependencies.
2. **Network-Level Mocking**: We spin up a real local dummy server to test our actual HTTP boundary, timeouts, and JSON parsing.
3. **Configuration Isolation**: Tests generate ephemeral configuration files to safely isolate execution from the user's production `~/.ctrlpi/` configs.
4. **End-to-End Transport Testing**: We test both the Stdio JSON-RPC interface and the Streamable HTTP interface exactly as an MCP client (like Claude Desktop) would.

## Step 1: The Mock Server (`mock_agent.py`)

Create a standalone Python script to act as the target hardware/API.

*   **Native Python Stdlib**: Use `http.server` and `json`.
*   **Stateful Memory**: Keep a global or class-level dictionary. If the bridge sends a `POST /write` to turn a light on, update the dictionary so the next `GET /read` returns the new state.
*   **Multi-Instance Support**: Allow the script to take a CLI argument (e.g., `sys.argv[1]`) to spawn multiple threaded servers on incremental ports (e.g., 9314, 9315). This is essential for testing device discovery and multi-bridge LAN setups.
*   **Bind to Localhost**: Hardcode the `server_address` to `127.0.0.1` to prevent test data from bleeding onto the real LAN.

## Step 2: The Test Runner (`test.js`)

Create a single file using Node's native test runner.

```javascript
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// 1. Isolate Configs
const TEST_DIR = path.join(os.tmpdir(), 'bridge-test');
// Write dummy configs pointing to localhost:9314

let mockProcess;

before(async () => {
  // 2. Spawn Mock Server
  mockProcess = spawn('python3', ['mock_agent.py', '1']);
  
  // Wait ~500ms for the port to bind, or poll a /hello endpoint
  await new Promise(r => setTimeout(r, 500));
  
  // 3. Start the Bridge (pointed at TEST_DIR)
});

after(() => {
  // 4. Teardown
  if (mockProcess) mockProcess.kill();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});
```

## Step 3: Write Integration Tests

Do not test internal JavaScript functions. Test the boundary.

**Testing HTTP:**
```javascript
test('list devices via HTTP', async () => {
  const res = await fetch('http://127.0.0.1:8316/mcp', {
    method: 'POST',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'list_devices', arguments: {} }
    })
  });
  const data = await res.json();
  assert.equal(data.result.content[0].text.includes('Mock Device'), true);
});
```

**Testing Stdio:**
Spawn a child process of `node server.js`, pipe a JSON string into `stdin`, and read `stdout` using a line-buffered readline interface to verify the MCP response.

## Step 4: Package.json Integration

Bind the test to the standard `npm` command without requiring any extra modules.

```json
{
  "scripts": {
    "test": "node --test test.js"
  }
}
```

## Summary for the AI Agent
When applying this to a new bridge, the agent should:
1. Read the bridge's API docs to understand what it connects to.
2. Write `mock_agent.py` to faithfully simulate those API responses.
3. Write `test.js` to spawn the mock, spin up the bridge with a scoped config, and fire real JSON-RPC requests against it.

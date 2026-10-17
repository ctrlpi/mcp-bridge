#!/usr/bin/env python3
# Mock ctrlPi agent for tests: answers the agents' REST API from memory, on loopback.
# Several projects keep an identical copy of this file; change them all together.
# `--port 0` takes a free port and prints it, so a test can read it back.
import os
import sys
import json
import time
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import TCPServer

class LocalHTTPServer(HTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind performs a reverse DNS lookup for server_name.
        # Tests only need a loopback listener, and hosted macOS runners can stall
        # on that lookup before the server announces its ephemeral port.
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]

class AgentHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Suppress HTTP request logs during test execution

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def send_error_json(self, message, status=400):
        self.send_json({"error": message}, status)

    def check_auth(self):
        if self.path == '/':
            return self.send_json({
                "agent": {
                    "version": "1.0.0",
                    "platform": self.server.agent_type,
                    "ip": "127.0.0.1"
                }
            })
            
        if self.path == '/hello':
            return True
        api_key = self.headers.get('Api-Key', '')
        if api_key != self.server.config.get('api_key'):
            self.send_error_json("Invalid Api-Key", 403)
            return False
        return True

    def read_body(self):
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length == 0:
            return {}
        post_data = self.rfile.read(content_length)
        return json.loads(post_data.decode('utf-8'))

    def do_GET(self):
        time.sleep(0.01) # Slight latency
        if not self.check_auth():
            return
            
        if self.path == '/':
            return self.send_json({
                "agent": {
                    "version": "1.0.0",
                    "platform": self.server.agent_type,
                    "ip": "127.0.0.1"
                }
            })
            
        if self.path == '/hello':
            return self.send_json({"name": self.server.agent_name, "ip": "127.0.0.1"})
            
        if self.path == '/config/read':
            # Like the real agents, /config/read never shows the agent's own key.
            cfg = self._public_config()
            cfg["agent"] = {
                "version": "1.0.0", 
                "platform": self.server.agent_type,
                "ip": "127.0.0.1"
            }
            if "gpios" not in cfg: cfg["gpios"] = {}
            if "sensors" not in cfg: cfg["sensors"] = {}
            return self.send_json(cfg)
            
        if self.path.startswith('/gpio/read'):
            parts = self.path.split('/')
            if len(parts) == 3: # /gpio/read
                return self.send_json(self.server.state.get("gpios", {}))
            else: # /gpio/read/<name>
                import urllib.parse
                import json
                gpio_id = urllib.parse.unquote(parts[3])
                if gpio_id == "error_pin":
                    return self.send_error_json("Simulated error", 500)
                    
                # Map using bridge-config.json
                try:
                    with open("bridge-config.json", "r") as bc:
                        b_cfg = json.load(bc)
                        for dev in b_cfg.get("devices", []):
                            if dev.get("name") == gpio_id and "gpio" in dev:
                                gpio_id = str(dev["gpio"])
                                break
                except: pass
                
                val = self.server.state.get("gpios", {}).get(gpio_id, {"value": 0})
                return self.send_json(val)

        if self.path == '/gpio/scan':
            return self.send_json([
                {"gpio": "26", "name": "mcptest", "value": 0, "type": "output", "pull": "none"}
            ])

        if self.path.startswith('/sensor/read'):
            parts = self.path.split('/')
            sensors = self.server.config.get("sensors", {})
            if len(parts) == 3: # /sensor/read
                res = {}
                for s_name, s_conf in sensors.items():
                    res[s_name] = self._mock_sensor_reading(s_name, s_conf)
                return self.send_json(res)
            else: # /sensor/read/<name>
                s_name = parts[3]
                if s_name not in sensors:
                    return self.send_error_json("Sensor not found", 404)
                return self.send_json({s_name: self._mock_sensor_reading(s_name, sensors[s_name])})

        if self.path == '/gpio/watched':
            return self.send_json({"watched": []})

        if self.path == '/logs':
            return self.send_json({"logs": ["Log line 1", "Log line 2"]})
            
        self.send_error_json("Not found", 404)

    def do_POST(self):
        time.sleep(0.01) # Slight latency
        if not self.check_auth():
            return
            
        body = self.read_body()
        
        if self.path == '/config/update':
            self.server.config.update(body)
            # The full config (bridges read their callback fields back), minus the key.
            return self.send_json(self._public_config())
            
        if self.path == '/config/load':
            # Like the real agents: a config without api_key keeps the current one.
            body.setdefault('api_key', self.server.config.get('api_key'))
            self.server.config = body
            if 'gpios' not in self.server.config:
                self.server.config['gpios'] = {}
            if 'sensors' not in self.server.config:
                self.server.config['sensors'] = {}
            return self.send_json({"status": "loaded"})

        if self.path.startswith('/gpio/write/'):
            import urllib.parse
            import json
            import threading
            import urllib.request
            gpio_id = urllib.parse.unquote(self.path.split('/')[3])
            
            # Map using bridge-config.json
            reversed_gpio = False
            try:
                with open("bridge-config.json", "r") as bc:
                    b_cfg = json.load(bc)
                    for dev in b_cfg.get("devices", []):
                        if dev.get("name") == gpio_id and "gpio" in dev:
                            gpio_id = str(dev["gpio"])
                            if dev.get("reversed") or dev.get("relay"):
                                reversed_gpio = True
                            break
            except: pass
            
            if "gpios" not in self.server.state:
                self.server.state["gpios"] = {}
                
            val = body.get("value")
            duration = body.get("duration")
            
            if val == "toggle":
                curr = self.server.state["gpios"].get(gpio_id, {}).get("value", 0)
                val = 1 if curr == 0 else 0
            elif val in ["on", "1"]:
                val = 1
            elif val in ["off", "0"]:
                val = 0
                
            if reversed_gpio:
                val = 1 if val == 0 else 0
                
            self.server.state["gpios"][gpio_id] = {"value": val}
            
            # Hardware loopback for tests: pin 6 -> pin 13
            changed_13 = None
            if gpio_id == "6":
                self.server.state["gpios"]["13"] = {"value": val}
                changed_13 = val
                
            # Trigger webhook
            def send_webhook(gid, gval):
                bridges = self.server.config.get("bridges", {})
                webhook_url = bridges.get("homekit") or bridges.get("matter") or bridges.get("mcp")
                webhook_key = bridges.get("homekit_key") or bridges.get("matter_key") or bridges.get("mcp_key")
                if webhook_url:
                    try:
                        req = urllib.request.Request(webhook_url, method="POST")
                        req.add_header('Content-Type', 'application/json')
                        if webhook_key:
                            req.add_header('api-key', webhook_key)
                        data = json.dumps({"source": "local", "type": "gpio", "gpio": int(gid), "value": gval}).encode('utf-8')
                        urllib.request.urlopen(req, data=data, timeout=1)
                    except Exception as e:
                        import sys
                        print(f"WEBHOOK FAILED: {e}", file=sys.stderr)
                    
            threading.Thread(target=send_webhook, args=(gpio_id, val)).start()
            if changed_13 is not None:
                threading.Thread(target=send_webhook, args=("13", changed_13)).start()
                
            # Handle duration
            if duration:
                def revert():
                    rev_val = 1 if val == 0 else 0
                    self.server.state["gpios"][gpio_id] = {"value": rev_val}
                    threading.Thread(target=send_webhook, args=(gpio_id, rev_val)).start()
                    if gpio_id == "6":
                        self.server.state["gpios"]["13"] = {"value": rev_val}
                        threading.Thread(target=send_webhook, args=("13", rev_val)).start()
                t = threading.Timer(float(duration), revert)
                t.start()
                
            return self.send_json({"status": "written", "value": val})

        if self.path.startswith('/gpio/config/'):
            gpio_id = self.path.split('/')[3]
            self.server.config.setdefault("gpios", {})[gpio_id] = body
            return self.send_json({"status": "configured"})

        if self.path.startswith('/sensor/config/'):
            s_name = self.path.split('/')[3]
            if body.get("remove"):
                self.server.config.get("sensors", {}).pop(s_name, None)
            else:
                self.server.config.setdefault("sensors", {})[s_name] = body
            return self.send_json({"status": "configured"})

        if self.path == '/restart':
            return self.send_json({"status": "restarting"})
            
        if self.path == '/upgrade':
            return self.send_json({"status": "upgrading"})
            
        self.send_error_json("Not found", 404)

    def _public_config(self):
        cfg = dict(self.server.config)
        cfg.pop('api_key', None)
        return cfg

    def _mock_sensor_reading(self, name, conf):
        script = conf.get("script", "")
        if "json" in script:
            return 1013
        elif "multi" in script:
            return {"cpu": 12, "mem": 48}
        elif "value" in script:
            return 42
        elif "on" in script:
            return 1
        return 0

def start_server(port, name, agent_type="pi"):
    server_address = ('127.0.0.1', port)
    httpd = LocalHTTPServer(server_address, AgentHandler)
    httpd.agent_name = name
    httpd.agent_type = agent_type
    
    # Initial state
    httpd.config = {
        "api_key": "your-secret-key",
        "gpios": {},
        "sensors": {}
    }
    httpd.state = {
        "gpios": {
            "13": {"value": 1},
            "6": {"value": 1}
        }
    }

    
    print(f"Starting mock agent '{name}' on port {httpd.server_port}...")
    httpd.serve_forever()

def run():
    import threading
    start_port = int(os.environ.get("MOCK_PORT", 9314))
    if len(sys.argv) == 2 and sys.argv[1].isdigit():
        count = int(sys.argv[1])
        if count < 1 or count > 6:
            print("Count must be between 1 and 6")
            sys.exit(1)
            
        threads = []
        for i in range(count):
            port = start_port + i
            name = f"agent-{port}"
            t = threading.Thread(target=start_server, args=(port, name), daemon=True)
            t.start()
            threads.append(t)
            
        print(f"Spawned {count} mock agents. Press Ctrl+C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
    else:
        parser = argparse.ArgumentParser()
        parser.add_argument('--port', type=int, required=True)
        parser.add_argument('--name', type=str, required=True)
        parser.add_argument('--type', type=str, default="pi")
        args = parser.parse_args()
        start_server(args.port, args.name, args.type)


if __name__ == '__main__':
    run()

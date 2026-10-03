#!/usr/bin/env python3
import sys
import json
import time
import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer

class AgentHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Suppress logs to avoid cluttering test output

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def send_error_json(self, message, status=400):
        self.send_json({"error": message}, status)

    def check_auth(self):
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
            
        if self.path == '/hello':
            return self.send_json({"name": self.server.agent_name, "ip": "127.0.0.1"})
            
        if self.path == '/config/read':
            return self.send_json({
                "agent": {
                    "version": "1.0.0", 
                    "platform": self.server.agent_type,
                    "ip": "127.0.0.1"
                },
                "gpios": self.server.config.get("gpios", {}),
                "sensors": self.server.config.get("sensors", {}),
            })
            
        if self.path.startswith('/gpio/read'):
            parts = self.path.split('/')
            if len(parts) == 3: # /gpio/read
                return self.send_json(self.server.state.get("gpios", {}))
            else: # /gpio/read/<name>
                gpio_id = parts[3]
                if gpio_id == "error_pin":
                    return self.send_error_json("Simulated error", 500)
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
            return self.send_json({"status": "updated"})
            
        if self.path == '/config/load':
            self.server.config = body
            if 'api_key' not in self.server.config:
                self.server.config['api_key'] = "your-secret-key"
            if 'gpios' not in self.server.config:
                self.server.config['gpios'] = {}
            if 'sensors' not in self.server.config:
                self.server.config['sensors'] = {}
            return self.send_json({"status": "loaded"})

        if self.path.startswith('/gpio/write/'):
            gpio_id = self.path.split('/')[3]
            if "gpios" not in self.server.state:
                self.server.state["gpios"] = {}
            
            val = body.get("value")
            if val == "toggle":
                curr = self.server.state["gpios"].get(gpio_id, {}).get("value", 0)
                val = 1 if curr == 0 else 0
            elif val in ["on", "1"]:
                val = 1
            elif val in ["off", "0"]:
                val = 0
            
            self.server.state["gpios"][gpio_id] = {"value": val}
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

    def _mock_sensor_reading(self, name, conf):
        script = conf.get("script", "")
        if "json" in script:
            return 1013
        elif "multi" in script:
            return {"cpu": 12, "mem": 48}
        elif "value" in script:
            return 42
        return 0

def start_server(port, name, agent_type="pi"):
    server_address = ('127.0.0.1', port)
    httpd = HTTPServer(server_address, AgentHandler)
    httpd.agent_name = name
    httpd.agent_type = agent_type
    
    # Initial state
    httpd.config = {
        "api_key": "your-secret-key",
        "gpios": {},
        "sensors": {}
    }
    httpd.state = {
        "gpios": {}
    }
    
    print(f"Starting mock agent '{name}' on port {port}...")
    httpd.serve_forever()

def run():
    import threading
    if len(sys.argv) == 2 and sys.argv[1].isdigit():
        count = int(sys.argv[1])
        if count < 1 or count > 6:
            print("Count must be between 1 and 6")
            sys.exit(1)
            
        threads = []
        for i in range(count):
            port = 9314 + i
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

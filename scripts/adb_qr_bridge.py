#!/usr/bin/env python3
import sys
import json
import time
import argparse
import subprocess

def send_event(data):
    print(json.dumps(data), flush=True)

def main():
    parser = argparse.ArgumentParser(description="ADB QR pairing bridge")
    parser.add_argument("--name", required=True, help="Service name, e.g. adb-cli-XXXXXX")
    parser.add_argument("--password", required=True, help="Pairing password")
    parser.add_argument("--timeout", type=int, default=60, help="Discovery timeout in seconds")
    parser.add_argument("--adb-path", default="adb", help="Path to adb executable")
    args = parser.parse_args()

    try:
        from zeroconf import ServiceBrowser, Zeroconf, ServiceInfo
    except ImportError:
        send_event({"status": "error", "message": "zeroconf package not installed"})
        sys.exit(2)

    class AdbPairingListener:
        def __init__(self, target_service_name: str):
            self.target_service_name = target_service_name
            self.ip_address = None
            self.port = None

        def remove_service(self, zeroconf, type, name):
            pass

        def add_service(self, zeroconf, type, name):
            info = zeroconf.get_service_info(type, name)
            if info and (self.target_service_name in name or "adb-" in name):
                addresses = info.parsed_addresses()
                if addresses:
                    self.ip_address = addresses[0]
                    self.port = info.port

        def update_service(self, zeroconf, type, name):
            pass

    zeroconf = Zeroconf()
    listener = AdbPairingListener(args.name)
    browser = ServiceBrowser(zeroconf, "_adb-tls-pairing._tcp.local.", listener)

    send_event({"status": "waiting", "message": f"Waiting for device to scan QR code (timeout {args.timeout}s)..."})

    start_time = time.time()
    while listener.ip_address is None and (time.time() - start_time) < args.timeout:
        time.sleep(0.3)

    zeroconf.close()

    if not listener.ip_address or not listener.port:
        send_event({"status": "timeout", "message": "Timed out waiting for device to scan QR code."})
        sys.exit(1)

    ip = listener.ip_address
    pairing_port = listener.port
    send_event({"status": "device_found", "ip": ip, "port": pairing_port, "message": f"Device detected at {ip}:{pairing_port}. Initiating pairing..."})

    # Run adb pair
    pair_cmd = [args.adb_path, "pair", f"{ip}:{pairing_port}", args.password]
    pair_res = subprocess.run(pair_cmd, capture_output=True, text=True)
    pair_out = (pair_res.stdout + "\n" + pair_res.stderr).strip()

    if pair_res.returncode != 0 and "successfully paired" not in pair_out.lower():
        send_event({"status": "pair_failed", "error": pair_out, "message": f"Pairing failed: {pair_out}"})
        sys.exit(1)

    send_event({"status": "paired", "ip": ip, "port": pairing_port, "message": "Pairing successful! Waiting for connection service..."})

    # Discover connect service
    class ConnectListener(AdbPairingListener):
        def __init__(self, target_ip):
            super().__init__("")
            self.target_ip = target_ip

        def add_service(self, zeroconf, type, name):
            info = zeroconf.get_service_info(type, name)
            if info:
                addresses = info.parsed_addresses()
                if addresses and addresses[0] == self.target_ip:
                    self.ip_address = addresses[0]
                    self.port = info.port

    zeroconf_conn = Zeroconf()
    conn_listener = ConnectListener(ip)
    conn_browser = ServiceBrowser(zeroconf_conn, "_adb-tls-connect._tcp.local.", conn_listener)

    conn_start = time.time()
    while conn_listener.port is None and (time.time() - conn_start) < 20:
        time.sleep(0.3)

    zeroconf_conn.close()

    connect_port = conn_listener.port
    if not connect_port:
        send_event({"status": "paired_only", "ip": ip, "message": f"Paired successfully with {ip}! Please connect using the IP & Port from your phone."})
        sys.exit(0)

    send_event({"status": "connecting", "ip": ip, "port": connect_port, "message": f"Connecting to {ip}:{connect_port}..."})

    conn_cmd = [args.adb_path, "connect", f"{ip}:{connect_port}"]
    conn_res = subprocess.run(conn_cmd, capture_output=True, text=True)
    conn_out = (conn_res.stdout + "\n" + conn_res.stderr).strip()

    if conn_res.returncode == 0 or "connected to" in conn_out.lower():
        send_event({"status": "connected", "ip": ip, "port": connect_port, "message": f"Successfully paired and connected to {ip}:{connect_port}!"})
        sys.exit(0)
    else:
        send_event({"status": "connect_failed", "ip": ip, "port": connect_port, "error": conn_out, "message": f"Paired, but connection failed: {conn_out}"})
        sys.exit(1)

if __name__ == "__main__":
    main()

"""Contained source integration: real H signer and callback, no provider/service."""
import asyncio
import json
import os
from pathlib import Path
import runpy
import sys

root = Path(os.environ["HARNESS_ROUTE_ROOT"])
sys.path.insert(0, str(root))
# Reuse H's existing CustomLogger import stub; signer, verifier and HMAC are real.
fixture = runpy.run_path(str(root / "tests/test_gateway_route_attestation.py"))
value = json.load(sys.stdin)
headers = [("x-opencode-session", value["session"]), ("x-opencode-inference-nonce", "1" * 32)]
request_headers = headers if value["mode"] != "invalid" else [headers[0], (headers[1][0], "4" * 32)]
key = "synthetic-native-integration-key"
receipt = fixture["_route_attestation"](
    fixture["Request"](request_headers), json.dumps({"model": "grok-4.6", "reasoning_effort": "xhigh"}).encode(),
    "grok", key, "2" * 32, requested={"model": "glm-5.3", "reasoning_effort": "high"},
    snapshot={"generation": 7, "selection_reason": "availability"})
assert receipt
if value["mode"] == "bad_signature":
    receipt = receipt[:-1] + ("0" if receipt[-1] != "0" else "1")
if value["mode"] == "missing":
    receipt = None
os.environ["QWEN_GATEWAY_KEY"] = key
callback = fixture["load_callback"]().proxy_handler_instance
result = asyncio.run(callback.async_post_call_response_headers_hook(
    {"model": "glm-5.3"}, None, fixture["Response"](receipt), request_headers=dict(headers)))
print(json.dumps(result))

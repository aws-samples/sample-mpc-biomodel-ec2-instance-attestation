#!/usr/bin/env python3
"""Fetch runtime configuration from SSM Parameter Store and write it to the
backend's systemd EnvironmentFile before the service starts.

This runs as a oneshot unit (boltz-config.service) ordered *before*
boltz-backend.service, so the values it writes are read by boltz-backend when it
starts. It exists to solve a chicken-and-egg problem under Zero Operator Access
(ZOA): the Amplify frontend origin that the backend must allow through CORS is
only known after the frontend deploys, but a ZOA instance has no SSH/SSM agent
and a read-only (dm-verity) root, so no operator can set it at runtime.

Instead the instance reads the origin from an SSM parameter using its own IAM
role over the SSM VPC endpoint, and writes CORS_ORIGINS into
/etc/boltz/environment on the writable overlay. No operator access is involved,
it re-applies on every boot (so it survives ASG instance replacement), and it
does not touch the verity-measured base image or PCR16.

The script is intentionally best-effort: if the parameter is missing/empty or
SSM is unreachable, it leaves the env file unchanged and exits 0, so the backend
still starts (with its default closed CORS policy) rather than failing to boot.
"""
import os
import sys
import urllib.request

CORS_PARAM = "/boltz-attestation/cors-origins"
ENV_FILE = "/etc/boltz/environment"


def _imds_region():
    """Resolve the instance region via IMDSv2 (token-authenticated)."""
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    if region:
        return region
    try:
        token_req = urllib.request.Request(  # nosemgrep: insecure-request-object
            "http://169.254.169.254/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"},
        )
        token = urllib.request.urlopen(token_req, timeout=2).read().decode()  # nosemgrep: dynamic-urllib-use-detected  # nosec B310
        region_req = urllib.request.Request(  # nosemgrep: insecure-request-object
            "http://169.254.169.254/latest/meta-data/placement/region",
            headers={"X-aws-ec2-metadata-token": token},
        )
        # IMDS is only reachable over plain HTTP at the link-local address 169.254.169.254;
        # it has no HTTPS endpoint. The request never leaves the instance, and the URL is
        # hardcoded (no user-controlled input).
        return urllib.request.urlopen(region_req, timeout=2).read().decode().strip()  # nosemgrep: dynamic-urllib-use-detected  # nosec B310
    except Exception:
        return None


def _get_param(name):
    try:
        import boto3  # system python3 already has boto3 (the backend uses it)
    except Exception:
        return ""
    try:
        ssm = boto3.client("ssm", region_name=_imds_region())
        value = ssm.get_parameter(Name=name)["Parameter"]["Value"].strip()
        return "" if value in ("", "None") else value
    except Exception:
        return ""


def _set_env(key, value):
    """Idempotently set KEY=value in ENV_FILE, replacing any prior line."""
    os.makedirs(os.path.dirname(ENV_FILE), exist_ok=True)
    lines = []
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, encoding="utf-8") as fh:
            lines = [ln for ln in fh.read().splitlines() if not ln.startswith(f"{key}=")]
    lines.append(f"{key}={value}")
    tmp = ENV_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, ENV_FILE)


def main():
    origins = _get_param(CORS_PARAM)
    if origins:
        _set_env("CORS_ORIGINS", origins)
        print(f"write-runtime-config: set CORS_ORIGINS from {CORS_PARAM}")
    else:
        print(f"write-runtime-config: {CORS_PARAM} empty/unavailable; leaving CORS closed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

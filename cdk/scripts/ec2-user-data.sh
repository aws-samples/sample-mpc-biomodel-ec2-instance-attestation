#!/bin/bash
#
# EC2 user-data for the Boltz attestation backend ASG instances.
#
# IMPORTANT: The PROD attested AMI (built by kiwi-ng) is immutable — read-only
# erofs root + dm-verity, no cloud-init, no SSH/SSM agent. It IGNORES user-data
# entirely and boots the baked-in boltz-backend.service on port 8000 directly.
#
# This script therefore only has an effect on the FOA (dev/test) AMI variant,
# which includes cloud-init. It performs light, non-attestation-affecting setup
# and a boot health confirmation. New application code is shipped by building a
# new AMI via the pipeline (AMI swap + ASG instance refresh), NOT by mutating a
# running instance.

set -e
exec > >(tee /var/log/boltz-user-data.log 2>&1) || true

echo "[boltz-user-data] starting $(date -u 2>/dev/null || echo now)"

# The baked image already runs boltz-backend.service on :8000. If systemd is
# available (FOA variant), make sure it is enabled and started.
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable boltz-backend.service 2>/dev/null || true
  systemctl start boltz-backend.service 2>/dev/null || true
fi

# Wait for the backend health endpoint so the ASG/NLB health check passes.
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    echo "[boltz-user-data] backend healthy"
    break
  fi
  echo "[boltz-user-data] waiting for backend health ($i/30)"
  sleep 10
done

echo "[boltz-user-data] done"

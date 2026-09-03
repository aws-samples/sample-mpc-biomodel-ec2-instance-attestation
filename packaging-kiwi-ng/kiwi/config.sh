#!/bin/bash
#=====================================
# Kiwi-NG Image Configuration Script
# PRODUCTION BUILD
# 
# This script runs inside the image root during the kiwi-ng
# configuration phase. It sets up the system for AWS and
# installs the Boltz application.
# 
# Features:
# - NO SSH access (firewall blocks port 22)
# - NO SSM Agent
# - NO cloud-init
# - Full kernel hardening
# - Minimal attack surface
#=====================================

set -e

# Function to handle errors
handle_error() {
    echo "[CONFIG.SH] ERROR: $1" >> /var/log/kiwi-config.log
    # Surface the in-image config log to stderr so the failure reason is visible
    # in the kiwi/CodeBuild build output (otherwise it is trapped inside the image root).
    echo "===== /var/log/kiwi-config.log (last 100 lines) =====" >&2
    tail -n 100 /var/log/kiwi-config.log >&2 2>/dev/null || true
    echo "=====================================================" >&2
    exit 1
}

# Trap errors
trap 'handle_error "Script failed at line $LINENO"' ERR

# Log config.sh execution
mkdir -p /var/log

# Detect the active kiwi profile. Kiwi exports the selected profile(s) into the
# config.sh environment as `kiwi_profiles`. foa => Full Operator Access (SSH + SSM),
# anything else (prod / unset) => production, no operator access.
test -f /.profile && . /.profile
IS_FOA=false
if [[ "${kiwi_profiles:-}" == *"foa"* ]]; then
    IS_FOA=true
fi
echo "[CONFIG.SH] Starting config.sh execution at $(date) (profile: ${kiwi_profiles:-prod}, FOA=${IS_FOA})" >> /var/log/kiwi-config.log

#======================================
# Configure DNS resolution during build
#--------------------------------------
echo "[CONFIG.SH] Configuring DNS resolution" >> /var/log/kiwi-config.log
rm -f /etc/resolv.conf
cat > /etc/resolv.conf << 'EOF'
nameserver 169.254.169.253
nameserver 8.8.8.8
EOF

#======================================
# Configure localhost networking
#--------------------------------------
echo "[CONFIG.SH] Configuring localhost networking" >> /var/log/kiwi-config.log

# Configure /etc/hosts
cat > /etc/hosts << 'EOF'
127.0.0.1   localhost localhost.localdomain
::1         localhost localhost.localdomain
EOF

# Create systemd-networkd config for loopback
mkdir -p /etc/systemd/network
cat > /etc/systemd/network/10-lo.network << 'EOF'
[Match]
Name=lo

[Network]
DHCP=no
IPv6AcceptRA=no

[Address]
Address=127.0.0.1/8

[Address]
Address=::1/128
EOF

# Enable systemd-networkd for basic networking
systemctl enable systemd-networkd || true
systemctl enable systemd-resolved || true
echo "[CONFIG.SH] Localhost networking configured" >> /var/log/kiwi-config.log

#======================================
# Configure Boltz user
#--------------------------------------
echo "[CONFIG.SH] Creating boltz user" >> /var/log/kiwi-config.log
if ! id boltz &>/dev/null; then
    groupadd -r boltz || true
    useradd -r -m -d /home/boltz -s /bin/bash -g boltz boltz || true
fi

# Add to TPM group (tss) for direct TPM access without sudo
groupadd -r tss 2>/dev/null || true
usermod -aG tss boltz 2>/dev/null || true

# Ensure TPM devices have correct permissions for tss group
mkdir -p /etc/udev/rules.d
cat > /etc/udev/rules.d/99-tpm.rules << 'EOF'
# TPM device permissions for tss group
KERNEL=="tpm[0-9]*", MODE="0660", GROUP="tss"
KERNEL=="tpmrm[0-9]*", MODE="0660", GROUP="tss"
EOF

# Note: No sudo needed for TPM tools - boltz user is in tss group with udev rules
echo "[CONFIG.SH] TPM access via tss group membership (no sudo needed)" >> /var/log/kiwi-config.log

# Create application directories
mkdir -p /opt/boltz/{app,models,logs,data}
chown -R boltz:boltz /opt/boltz
chmod 750 /opt/boltz

# Create config directory
mkdir -p /etc/boltz
chown root:boltz /etc/boltz
chmod 750 /etc/boltz

echo "[CONFIG.SH] Boltz user created successfully" >> /var/log/kiwi-config.log

#======================================
# Configure TPM
#--------------------------------------
echo "[CONFIG.SH] Configuring TPM" >> /var/log/kiwi-config.log

# Create TPM configuration directory
mkdir -p /etc/tpm2-tss

# Configure TPM resource manager
cat > /etc/tpm2-tss/tpm2-tss-fapi.conf << 'EOF'
{
    "profile_name": "P_ECCP256SHA256",
    "profile_dir": "/etc/tpm2-tss/fapi-profiles/",
    "user_dir": "~/.local/share/tpm2-tss/user/keystore",
    "system_dir": "/var/lib/tpm2-tss/system/keystore",
    "tcti": "device:/dev/tpmrm0",
    "system_pcrs": [],
    "log_dir": "/var/log/tpm2-tss"
}
EOF

# Create log directory
mkdir -p /var/log/tpm2-tss
chmod 750 /var/log/tpm2-tss

echo "[CONFIG.SH] TPM configured" >> /var/log/kiwi-config.log

#======================================
# Install NVIDIA GPU Drivers (per AWS AL2023 docs)
# https://docs.aws.amazon.com/linux/al2023/ug/nvidia-drivers.html
#--------------------------------------
echo "[CONFIG.SH] Installing NVIDIA GPU drivers" >> /var/log/kiwi-config.log

# Add NVIDIA repository
dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/amzn2023/x86_64/cuda-amzn2023.repo >> /var/log/kiwi-config.log 2>&1 || echo "[CONFIG.SH] Warning: Failed to add NVIDIA repo" >> /var/log/kiwi-config.log

# Install the NVIDIA driver and CUDA *driver* libraries (libcuda.so) only. The full CUDA
# toolkit (nvcc, dev/static libs) and cuDNN are intentionally NOT installed: the PyTorch
# cu124 wheels (requirements.txt, --extra-index-url .../whl/cu124) bundle their own CUDA
# runtime and cuDNN, so only the kernel driver + driver libs are needed on the host. This
# removes several GB from both the build and the image.
dnf install -y nvidia-driver nvidia-driver-cuda nvidia-driver-cuda-libs >> /var/log/kiwi-config.log 2>&1 || echo "[CONFIG.SH] Warning: Failed to install nvidia-driver" >> /var/log/kiwi-config.log

echo "[CONFIG.SH] NVIDIA driver installation completed (CUDA runtime/cuDNN come from the torch wheels)" >> /var/log/kiwi-config.log

#======================================
# Install Python dependencies
#--------------------------------------
echo "[CONFIG.SH] Installing Python dependencies" >> /var/log/kiwi-config.log

# Step 1: Handle rpm-installed packages that conflict with pip
# AL2023 has requests 2.25.1 installed via rpm which pip can't uninstall
# We need to force upgrade it before installing other packages
echo "[CONFIG.SH] Upgrading system packages that conflict with pip..." >> /var/log/kiwi-config.log
pip3 install --no-cache-dir --ignore-installed requests >> /var/log/kiwi-config.log 2>&1 || true

# Step 2: Install all application dependencies from requirements.txt
# Note: requirements.txt includes --extra-index-url for PyTorch CUDA wheels
if [ -f /opt/boltz/app/requirements.txt ]; then
    echo "[CONFIG.SH] Installing dependencies from requirements.txt..." >> /var/log/kiwi-config.log
    echo "[CONFIG.SH] (includes PyTorch with CUDA via --extra-index-url)" >> /var/log/kiwi-config.log
    # NOTE: `set -e` + the ERR trap would abort the whole build if pip returns
    # non-zero, defeating the "treat as warning" intent below. Capture the status
    # explicitly so a partial/failed pip install is a warning, not a fatal error.
    pip_status=0
    pip3 install --no-cache-dir -r /opt/boltz/app/requirements.txt >> /var/log/kiwi-config.log 2>&1 || pip_status=$?
    if [ "$pip_status" -ne 0 ]; then
        echo "[CONFIG.SH] Warning: Some packages from requirements.txt may have failed to install (pip exit $pip_status)" >> /var/log/kiwi-config.log
    fi
fi

# Step 3: Verify boltz is installed and ensure CLI is in PATH
if python3 -c "import boltz; print(f'Boltz version: {boltz.__version__}')" >> /var/log/kiwi-config.log 2>&1; then
    echo "[CONFIG.SH] Boltz module installed successfully" >> /var/log/kiwi-config.log
    
    # Ensure boltz CLI is accessible in /usr/local/bin
    if [ ! -f /usr/local/bin/boltz ]; then
        # Find the boltz script wherever pip installed it
        BOLTZ_FOUND=$(find /usr -name boltz -type f 2>/dev/null | head -1)
        if [ -n "$BOLTZ_FOUND" ]; then
            ln -sf "$BOLTZ_FOUND" /usr/local/bin/boltz
            echo "[CONFIG.SH] Created symlink /usr/local/bin/boltz -> $BOLTZ_FOUND" >> /var/log/kiwi-config.log
        else
            echo "[CONFIG.SH] Warning: Could not find boltz CLI script" >> /var/log/kiwi-config.log
        fi
    else
        echo "[CONFIG.SH] Boltz CLI available at /usr/local/bin/boltz" >> /var/log/kiwi-config.log
    fi
else
    echo "[CONFIG.SH] ERROR: Boltz module failed to import" >> /var/log/kiwi-config.log
fi

# Set ownership
chown -R boltz:boltz /opt/boltz

echo "[CONFIG.SH] Python dependencies installed" >> /var/log/kiwi-config.log

#======================================
# Enable services
#--------------------------------------
echo "[CONFIG.SH] Enabling services" >> /var/log/kiwi-config.log

# The firewall is a static nftables ruleset enabled in the firewall section
# below (boltz-firewall.service). firewalld is intentionally not used.

# Enable the runtime-config oneshot (fetches CORS_ORIGINS from SSM at boot,
# ordered before boltz-backend).
if [ -f /etc/systemd/system/boltz-config.service ]; then
    systemctl enable boltz-config || true
    echo "[CONFIG.SH] Enabled boltz-config service" >> /var/log/kiwi-config.log
fi

# Enable the Boltz backend service (the UI is hosted on Amplify — no local frontend).
if [ -f /etc/systemd/system/boltz-backend.service ]; then
    systemctl enable boltz-backend || true
    echo "[CONFIG.SH] Enabled boltz-backend service" >> /var/log/kiwi-config.log
fi

# Enable TPM services
systemctl enable tpm2-abrmd 2>/dev/null || true

if [ "$IS_FOA" = true ]; then
    # FOA (DEV/TEST): enable operator access so the instance is reachable for debugging.
    echo "[CONFIG.SH] FOA build: enabling SSH, SSM Agent, cloud-init, ec2-instance-connect" >> /var/log/kiwi-config.log

    # ec2-user with passwordless sudo (SSM/SSH login target).
    if ! id ec2-user &>/dev/null; then
        useradd -m -d /home/ec2-user -s /bin/bash ec2-user || true
    fi
    echo "ec2-user ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/ec2-user
    chmod 440 /etc/sudoers.d/ec2-user
    mkdir -p /home/ec2-user/.ssh
    chmod 700 /home/ec2-user/.ssh
    chown -R ec2-user:ec2-user /home/ec2-user

    systemctl enable sshd || true
    systemctl enable amazon-ssm-agent || true
    systemctl enable cloud-init-local || true
    systemctl enable cloud-init || true
    systemctl enable cloud-config || true
    systemctl enable cloud-final || true
else
    # PRODUCTION: Do NOT enable SSH, SSM, or cloud-init
    echo "[CONFIG.SH] SSH, SSM, and cloud-init are DISABLED (production mode)" >> /var/log/kiwi-config.log
fi

echo "[CONFIG.SH] Services enabled" >> /var/log/kiwi-config.log

#======================================
# Configure firewall (static nftables, fail-closed)
#--------------------------------------
# We use a STATIC nftables ruleset instead of firewalld. firewalld is a runtime
# daemon that regenerates its rules from XML at every boot, so a failed daemon
# start means no rules, which means an open instance. The static ruleset in
# /etc/nftables/boltz-firewall.nft is the enforcement artifact itself: it lives
# in the dm-verity sealed rootfs and is loaded once at boot (before
# network-pre.target) by boltz-firewall.service, with base policy `drop`.
# Coverage is interface-agnostic, so any ENI (primary or hot-plugged) is denied
# by default. See boltz-firewall.service and the .nft file for the rules.
echo "[CONFIG.SH] Configuring static nftables firewall (fail-closed)" >> /var/log/kiwi-config.log

FW_RULESET=/etc/nftables/boltz-firewall.nft
if [ "$IS_FOA" = true ]; then
    # DEV/TEST ONLY: open SSH by activating the marked rule in the sealed ruleset.
    sed -i 's/# __FOA__ //' "$FW_RULESET"
    echo "[CONFIG.SH] FOA build: SSH (tcp/22) enabled in nftables ruleset" >> /var/log/kiwi-config.log
else
    echo "[CONFIG.SH] Production build: SSH not opened (nftables policy drop)" >> /var/log/kiwi-config.log
fi

# Validate the FINAL ruleset at BUILD time so a malformed firewall fails the AMI
# build rather than silently leaving the running instance open.
if ! nft -c -f "$FW_RULESET" >> /var/log/kiwi-config.log 2>&1; then
    handle_error "nftables ruleset $FW_RULESET failed validation (nft -c)"
fi

# Enable our loader and make sure firewalld can never take over.
systemctl enable boltz-firewall.service || true
systemctl disable firewalld 2>/dev/null || true
systemctl mask firewalld 2>/dev/null || true

echo "[CONFIG.SH] nftables firewall configured (backend port 8000 only; policy drop; NO SSH in prod)" >> /var/log/kiwi-config.log

#======================================
# System hardening (FULL for production)
#--------------------------------------
echo "[CONFIG.SH] Applying system hardening (full production hardening)" >> /var/log/kiwi-config.log

# Kernel parameters - full hardening
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/99-boltz-security.conf << 'EOF'
# Network security
net.ipv4.ip_forward = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1

# Reverse path filtering (strict): drop any packet whose source address is not
# routable back out the interface it arrived on. This kills asymmetric-routing
# traffic on a hot-plugged secondary ENI (its replies would try to exit the
# primary interface). Strict mode is safe here because the instance uses a
# single primary ENI; if you intentionally run multi-homed with policy routing,
# relax this to 2 (loose).
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Kernel hardening - FULL for production
kernel.randomize_va_space = 2
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
EOF

echo "[CONFIG.SH] System hardening applied (full production)" >> /var/log/kiwi-config.log

#======================================
# Cleanup
#--------------------------------------
echo "[CONFIG.SH] Cleaning up" >> /var/log/kiwi-config.log

# Clear package cache
dnf clean all 2>/dev/null || true

# Clear temp files
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true

echo "[CONFIG.SH] Config.sh completed successfully at $(date)" >> /var/log/kiwi-config.log
exit 0
# Kiwi-NG Packaging for Boltz Protein Folding AMI

This directory contains the kiwi-ng configuration and scripts to package the Boltz Protein Folding application into an attestable AWS AMI with NitroTPM support.

## Overview

[Kiwi-NG](https://osinside.github.io/kiwi/) is an OS image builder that produces attestable system images from a declarative, version-controlled description. The build is repeatable, but it is not bit-for-bit reproducible by default: package versions resolve from the upstream repositories at build time unless they are pinned. This packaging creates an Amazon Machine Image (AMI) suitable for running on AWS EC2 instances with:

- NitroTPM support for hardware attestation
- Secure boot enabled
- Minimal attack surface
- Pre-installed Boltz application

## Directory Structure

```
packaging-kiwi-ng/
├── README.md                    # This file
├── kiwi/
│   ├── config.xml              # kiwi-ng image config — defines the `prod` and `foa` profiles
│   ├── config.sh               # In-image config script (profile-aware via $kiwi_profiles)
│   ├── add-gpg-key.sh          # Repo GPG key customization
│   ├── edit_boot_install.sh    # Boot/install edit hook
│   └── images.sh               # Post-build image script
├── scripts/
│   ├── build.sh                # Build the AMI (kiwi-ng); --profile prod|foa (default prod)
│   ├── install-deps.sh         # Install kiwi-ng + build dependencies
│   └── upload-ami.sh           # Import the raw image + register the AMI (coldsnap + register-image)
└── overlay/                    # Files copied into the image root
    └── etc/
        ├── systemd/system/
        │   └── boltz-backend.service   # Backend API service (uvicorn :8000)
        └── boltz/
            └── config.yaml             # Backend app config
```

> Profiles: a single `kiwi/config.xml` defines `prod` (attestable, no operator access)
> and `foa` (adds SSH/SSM/cloud-init for dev/test). Select with `build.sh --profile`.

## Prerequisites

### Build Environment

- Linux build host (Amazon Linux 2023, Ubuntu 22.04+, or Fedora 38+)
- kiwi-ng >= 10.0
- AWS CLI configured with appropriate permissions

> In this project the AMI is normally built by the pipeline's CodeBuild (reserved EC2
> fleet), triggered by `scripts/package-and-upload.sh` — these steps are for manual/local
> builds.

### AWS Permissions

The following IAM permissions are required:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "ec2:RegisterImage",
                "ec2:CreateSnapshot",
                "ec2:ImportSnapshot",
                "ec2:DescribeImportSnapshotTasks",
                "ec2:DescribeSnapshots",
                "ec2:DescribeImages",
                "ec2:CopyImage",
                "ec2:ModifyImageAttribute",
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "*"
        }
    ]
}
```

## Quick Start

### 1. Install Dependencies

```bash
cd packaging-kiwi-ng
./scripts/install-deps.sh
```

### 2. Build the Image

```bash
./scripts/build.sh
```

### 3. Upload to AWS

```bash
./scripts/upload-ami.sh --region us-east-1 --name "boltz-protein-folding-v1.0.0"
```

## Configuration

### Main Configuration (`kiwi/config.xml`)

The main kiwi-ng configuration defines:

- Base image (Amazon Linux 2023)
- Partition layout with dm-verity
- Boot configuration for Nitro
- TPM integration
- Package selection

### Customization

#### Adding Packages

Packages are declared inline in `kiwi/config.xml` under `<packages type="image">`
(common) or a profile-scoped block (`profiles="prod"` / `profiles="foa"`), e.g.:

```xml
<packages type="image">
    <package name="python3"/>
    <package name="tpm2-tools"/>
    <!-- add your package here -->
</packages>
```

#### Changing Boot Parameters

The image uses systemd-boot (UEFI). Edit the `kernelcmdline` on the `<type>` element
in `kiwi/config.xml` (each profile has its own `<type>`):

```xml
<type image="oem" firmware="uefi"
      kernelcmdline="console=ttyS0 rd.shell=0 systemd.getty_auto=false ...">
  <bootloader name="systemd_boot" timeout="10"/>
</type>
```

#### Application Configuration

Edit `overlay/etc/boltz/config.yaml`:

```yaml
server:
  port: 8000
  host: 0.0.0.0
attestation:
  enabled: true
  tpm_device: /dev/tpmrm0
```

## Build Options

### Production Build (Default)

Full security hardening with no operator access (recommended for production):

```bash
./scripts/build.sh --profile prod        # prod is also the default
./scripts/upload-ami.sh --name "boltz-protein-folding-prod"
```

**Features:**
- No SSH access
- No SSM Agent
- No cloud-init
- No EC2 Instance Connect
- Serial console disabled
- Minimal attack surface

### Full Operator Access (FOA) Build - DEV/TEST ONLY

⚠️ **WARNING: This build profile is for development and testing only. DO NOT use in production!**

Includes SSH, SSM, and console access for debugging:

```bash
./scripts/build.sh --profile foa
```

**Features:**
- SSH access enabled (port 22)
- SSM Agent enabled
- Cloud-init enabled
- EC2 Instance Connect enabled
- Serial console enabled (`systemd.getty_auto=true`)
- `ec2-user` with sudo access
- Debugging tools (vim, htop, strace, tcpdump)
- NVIDIA GPU drivers (nvidia-driver, nvidia-driver-cuda)
- CUDA toolkit 12.4
- PyTorch with CUDA support

#### Testing FOA Instance

After launching the FOA AMI, SSH into the instance and run these commands to verify everything is working:

**1. Check All Service Status:**

```bash
# Check the Boltz backend service (there is no local frontend — the UI is on Amplify)
sudo systemctl status boltz-backend

# Check infrastructure services (FOA image only)
sudo systemctl status amazon-ssm-agent
sudo systemctl status sshd
sudo systemctl status firewalld
sudo systemctl status cloud-init

# Check TPM service (if available)
sudo systemctl status tpm2-abrmd

# Quick status check for all services at once
for svc in boltz-backend amazon-ssm-agent sshd firewalld cloud-init tpm2-abrmd; do
  echo "=== $svc ===" && systemctl is-active $svc 2>/dev/null || echo "not found"
done
```

**2. View Service Logs:**

```bash
# View backend logs
sudo journalctl -u boltz-backend -f

# View last 50 lines of backend logs
sudo journalctl -u boltz-backend -n 50

# View kiwi config log (build-time configuration)
cat /var/log/kiwi-config.log
```

**3. Test Backend API:**

```bash
# Health check endpoint
curl -s http://localhost:8000/health | jq .

# API documentation (Swagger UI)
curl -s http://localhost:8000/docs

# OpenAPI schema
curl -s http://localhost:8000/openapi.json | jq .

# Test from outside instance (requires Security Group port 8000 open)
curl -s http://YOUR_PUBLIC_IP:8000/health
```

**4. Verify NVIDIA GPU (if using GPU instance):**

```bash
# Check NVIDIA driver
nvidia-smi

# Check CUDA
nvcc --version

# Test PyTorch GPU access
python3 -c "import torch; print(f'CUDA available: {torch.cuda.is_available()}'); print(f'GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}')"
```

**5. Check Network Ports:**

```bash
# List listening ports (backend :8000, SSH :22 on the FOA image)
ss -tlnp | grep -E ':(8000|22)'

# Check firewall rules
sudo firewall-cmd --list-all
```

**6. Restart Services (if needed):**

```bash
# Restart backend
sudo systemctl restart boltz-backend

# Reload systemd after service file changes
sudo systemctl daemon-reload
```

## Launch instance

### Delete the old AMI first
```bash
aws ec2 deregister-image --image-id <old-ami-id> --region us-east-1 --delete-associated-snapshots

echo "Old AMI deleted"
```
### Launch instance

An example aws cli EC2 run instance command

```bash
aws ec2 run-instances \
--count '1' \
--image-id '<ami-id>' \
--instance-type 'g5.4xlarge' \
--key-name 'your-kp' \
--ebs-optimized \
--network-interfaces '{"AssociatePublicIpAddress":true,"DeviceIndex":0,"Groups":["<your-sg>"]}' \
--tag-specifications '{"ResourceType":"instance","Tags":[{"Key":"Name","Value":"test_boltz_foa"}]}' \
--iam-instance-profile '{"Arn":"arn:aws:iam::<account-id>:instance-profile/<your-tee-instance-profile>"}' \
--metadata-options '{"HttpTokens":"required"}' \
--private-dns-name-options '{"HostnameType":"ip-name","EnableResourceNameDnsARecord":true,"EnableResourceNameDnsAAAARecord":false}' 



```


## Security Features

### TPM Integration

The image is configured to use AWS NitroTPM for:

- **PCR measurements**: Boot process integrity
- **Sealed secrets**: Encryption keys bound to TPM state
- **Remote attestation**: Prove system integrity to clients

### Secure Boot

- UEFI Secure Boot enabled
- Signed kernel and bootloader
- dm-verity for root filesystem integrity

### IMA (Integrity Measurement Architecture)

All executed binaries are measured into PCR 10:

```
ima_policy=tcb ima_hash=sha256
```

### Minimal Attack Surface

- No SSH by default (use SSM Session Manager)
- Firewall configured for application ports only
- Non-root application user
- Read-only root filesystem (where applicable)

## Attestation Flow

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Client        │     │   Boltz AMI     │     │   AWS Nitro     │
│                 │     │                 │     │   Attestation   │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │  1. Request           │                       │
         │  attestation          │                       │
         │──────────────────────>│                       │
         │                       │                       │
         │                       │  2. Get attestation   │
         │                       │  document             │
         │                       │──────────────────────>│
         │                       │                       │
         │                       │  3. Signed document   │
         │                       │  with PCR values      │
         │                       │<──────────────────────│
         │                       │                       │
         │  4. Return document   │                       │
         │<──────────────────────│                       │
         │                       │                       │
         │  5. Verify signature  │                       │
         │  and PCR values       │                       │
         │                       │                       │
```

## Expected PCR Values

After build, expected PCR values are recorded:

| PCR | Description | Source |
|-----|-------------|--------|
| 0 | BIOS/UEFI | Firmware |
| 1 | BIOS/UEFI config | Firmware |
| 2-3 | Option ROMs | Hardware |
| 4 | Boot loader | GRUB2 |
| 5 | Boot config | grub.cfg |
| 7 | Secure Boot state | UEFI |
| 10 | IMA measurements | Runtime |

## Troubleshooting

### Debugging "Boltz CLI is not installed" Error

If you see "Boltz CLI is not installed. Install with: pip install boltz[cuda]" when trying to run predictions, follow these steps to diagnose:

**Step 1: Check if Boltz CLI is installed**

```bash
# Check if boltz command exists in PATH
which boltz
# Expected: /usr/local/bin/boltz or similar

# Try running boltz
boltz --help

# Check Python module
python3 -c "import boltz; print(f'Boltz version: {boltz.__version__}')"

# List installed packages
pip3 list | grep -i boltz
```

**Step 2: Check the kiwi config log (what happened during image build)**

```bash
# View the full config log from image build
cat /var/log/kiwi-config.log

# Search for boltz-specific entries
cat /var/log/kiwi-config.log | grep -i boltz

# Look for errors
cat /var/log/kiwi-config.log | grep -i -E "(error|failed|warning)"
```

**Step 3: Check which Python/pip is being used**

```bash
# Which python
which python3
python3 --version

# Check pip location
which pip3
pip3 --version

# Check where packages are installed
pip3 show boltz

# Check pip installation location
pip3 list --path /usr/local/lib/python3.9/site-packages | grep -i boltz
pip3 list --path /usr/local/lib64/python3.9/site-packages | grep -i boltz
```

**Step 4: Check what user the backend runs as**

```bash
# See what user the backend runs as
cat /etc/systemd/system/boltz-backend.service | grep User

# Check the boltz user's environment
sudo -u boltz bash -c 'echo $PATH'
sudo -u boltz bash -c 'which python3'

# Check if boltz user can find the package
sudo -u boltz python3 -c "import boltz; print(boltz.__version__)"
```

**Step 5: Check the actual error in backend logs**

```bash
# View backend logs
sudo journalctl -u boltz-backend -n 100

# Look for the specific boltz error
sudo journalctl -u boltz-backend | grep -i "not installed"

# Check if the backend started properly
sudo systemctl status boltz-backend
```

**Step 6: Check requirements.txt version conflicts**

```bash
# View the requirements.txt
cat /opt/boltz/app/requirements.txt | grep -i boltz

# The boltz version should be >= 0.4.0 (NOT >= 1.0.0!)
# If it shows boltz>=1.0.0, that's the bug - version 1.0.0 doesn't exist
```

**Step 7: Manual fix (if boltz is missing)**

```bash
# Install boltz globally
sudo pip3 install boltz

# Or install with all deps
sudo pip3 install boltz numpy biopython einops

# Restart backend
sudo systemctl restart boltz-backend

# Verify
python3 -c "import boltz; print(boltz.__version__)"
boltz --help
```

**Step 8: Check for PATH issues**

```bash
# The boltz CLI is installed in pip's bin directory
# Find where pip installs scripts
pip3 show -f boltz | grep -E "^Location|Scripts"

# Check if that directory is in PATH
echo $PATH

# Find the actual boltz script
find /usr -name boltz -type f 2>/dev/null
find /home -name boltz -type f 2>/dev/null
```

**Common Issues:**

| Issue | Cause | Fix |
|-------|-------|-----|
| `boltz>=1.0.0` not found | requirements.txt has wrong version | Change to `boltz>=0.4.0` |
| Module not found | pip installed to different location | Use `sudo pip3 install` or check PYTHONPATH |
| Command not found | Script not in PATH | Add `/usr/local/bin` to PATH |
| Permission denied | Wrong file permissions | `sudo chown -R boltz:boltz /opt/boltz` |

### Build Fails

```bash
# Check kiwi-ng logs
cat /var/log/kiwi.log

# Verbose build
./scripts/build.sh --verbose
```

### TPM Not Available

```bash
# Check TPM device
ls -la /dev/tpm*

# Verify TPM2 tools
tpm2_getcap properties-fixed
```

### AMI Upload Fails

```bash
# Check AWS credentials
aws sts get-caller-identity

# Verify S3 bucket access
aws s3 ls s3://your-bucket/
```

## Output Files

After successful build:

- `output/boltz-ami.raw` - Raw disk image
- `output/boltz-ami.vmdk` - VMware format (intermediate)
- `output/manifest.json` - Build manifest with checksums
- `output/pcr-values.json` - Expected PCR measurements

## References

- [Kiwi-NG Documentation](https://osinside.github.io/kiwi/)
- [AWS NitroTPM](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm.html)
- [AWS AMI Import](https://docs.aws.amazon.com/vm-import/latest/userguide/vmimport-image-import.html)
- [TPM2 Tools](https://github.com/tpm2-software/tpm2-tools)

## License

This packaging configuration is licensed under the MIT License.
#!/bin/bash
#=====================================
# Upload AMI to AWS using coldsnap
# 
# This script uploads the built image to AWS as an EBS snapshot
# and registers it as a TPM-enabled AMI using coldsnap.
# Based on: https://github.com/aws-samples/sample-mpc-app-packaging-using-kiwi-ng
#=====================================

set -euo pipefail

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="${PROJECT_DIR}/output"
LOGS_DIR="${PROJECT_DIR}/logs"
LOG_FILE=""  # Will be set based on timestamp

# Default configuration
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
IMAGE_NAME="boltz-protein-folding-attestable"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Upload the built image to AWS as an AMI using coldsnap.

Options:
    -r, --region REGION     AWS region (default: us-east-1 or AWS_DEFAULT_REGION)
    -n, --name NAME         AMI name prefix (default: boltz-protein-folding-attestable)
    -i, --image FILE        Image file to upload (auto-detected if not specified)
    -h, --help             Show this help message

Examples:
    $(basename "$0")
    $(basename "$0") --region eu-west-1 --name my-custom-ami
EOF
}

#======================================
# Setup logging
#--------------------------------------

setup_logging() {
    # Create logs directory structure
    mkdir -p "${LOGS_DIR}/image-build"
    mkdir -p "${LOGS_DIR}/ami-upload"
    
    # Generate timestamped log filename
    local timestamp=$(date +%Y%m%d-%H%M%S)
    LOG_FILE="${LOGS_DIR}/ami-upload/upload-${IMAGE_NAME}-${timestamp}.log"
    log_info "Log file: $LOG_FILE"
}

#======================================
# Install coldsnap if needed
#--------------------------------------

install_coldsnap() {
    if command -v coldsnap &> /dev/null || [ -f "$HOME/.cargo/bin/coldsnap" ]; then
        log_info "coldsnap is already installed"
        return 0
    fi
    
    log_info "Installing coldsnap..."
    
    # Clone and build coldsnap
    if [ ! -d "/tmp/coldsnap" ]; then
        git clone https://github.com/awslabs/coldsnap.git /tmp/coldsnap
    fi
    
    pushd /tmp/coldsnap
    cargo install --locked coldsnap
    popd
    
    log_info "coldsnap installed to ~/.cargo/bin/coldsnap"
}

#======================================
# Find image file
#--------------------------------------

find_image() {
    if [ -n "${IMAGE_FILE:-}" ] && [ -f "$IMAGE_FILE" ]; then
        return 0
    fi
    
    # Look for .raw files in output directory
    local raw_files=("$OUTPUT_DIR"/*.raw)
    
    if [ -f "${raw_files[0]}" ]; then
        IMAGE_FILE="${raw_files[0]}"
        log_info "Found image file: $IMAGE_FILE"
        return 0
    fi
    
    log_error "No image file found in $OUTPUT_DIR"
    log_info "Run ./scripts/build.sh first to create the image"
    return 1
}

#======================================
# Check AWS credentials
#--------------------------------------

check_aws_credentials() {
    log_info "Checking AWS credentials..."
    
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or invalid"
        log_info "Run 'aws configure' to set up credentials"
        exit 1
    fi
    
    local identity
    identity=$(aws sts get-caller-identity --output json)
    local account
    account=$(echo "$identity" | jq -r '.Account')
    local arn
    arn=$(echo "$identity" | jq -r '.Arn')
    
    log_info "AWS Account: $account"
    log_info "Identity: $arn"
}

#======================================
# Upload image using coldsnap
#--------------------------------------

upload_snapshot() {
    log_info "Uploading image to EBS snapshot using coldsnap..."
    log_info "This may take several minutes depending on image size..."
    log_info "Region: $REGION"
    
    # Use coldsnap to upload directly to EBS snapshot
    local coldsnap_cmd="${HOME}/.cargo/bin/coldsnap"
    if command -v coldsnap &> /dev/null; then
        coldsnap_cmd="coldsnap"
    fi
    
    # coldsnap uses AWS_REGION environment variable for region
    export AWS_REGION="$REGION"
    
    SNAPSHOT_ID=$("$coldsnap_cmd" upload --wait --description "Boltz Protein Folding AMI" "$IMAGE_FILE" 2>&1 | tail -1)
    
    if [ -z "$SNAPSHOT_ID" ] || [[ "$SNAPSHOT_ID" != snap-* ]]; then
        log_error "Failed to create snapshot. Output: $SNAPSHOT_ID"
        exit 1
    fi
    
    log_info "Created snapshot: $SNAPSHOT_ID"
}

#======================================
# Register AMI with TPM support
#--------------------------------------

register_ami() {
    log_info "Registering AMI with TPM support..."
    
    # Get architecture
    local arch
    arch=$(uname -p)
    
    # Convert aarch64 to arm64 for AMI registration
    if [ "$arch" == "aarch64" ]; then
        arch="arm64"
    fi
    
    # Generate AMI name with timestamp
    local ami_name="${IMAGE_NAME}-$(date +%Y%m%d%H%M)"
    
    # Register the AMI with TPM support
    local result
    result=$(aws ec2 register-image \
        --region "$REGION" \
        --name "$ami_name" \
        --virtualization-type hvm \
        --boot-mode uefi \
        --architecture "$arch" \
        --root-device-name /dev/xvda \
        --block-device-mappings "DeviceName=/dev/xvda,Ebs={SnapshotId=${SNAPSHOT_ID}}" \
        --tpm-support v2.0 \
        --ena-support \
        --output json)
    
    AMI_ID=$(echo "$result" | jq -r '.ImageId')
    
    if [ -z "$AMI_ID" ] || [ "$AMI_ID" == "null" ]; then
        log_error "Failed to register AMI"
        exit 1
    fi
    
    log_info "AMI registered: $AMI_ID"
    
    # Tag the AMI
    log_info "Tagging AMI..."
    aws ec2 create-tags \
        --region "$REGION" \
        --resources "$AMI_ID" "$SNAPSHOT_ID" \
        --tags \
            "Key=Name,Value=$ami_name" \
            "Key=Application,Value=boltz-protein-folding" \
            "Key=CreatedBy,Value=kiwi-ng" \
            "Key=TPMSupport,Value=v2.0"
    
    echo ""
    echo "========================================"
    echo " AMI Registration Complete!"
    echo "========================================"
    echo ""
    echo "AMI ID: $AMI_ID"
    echo "AMI Name: $ami_name"
    echo "Snapshot ID: $SNAPSHOT_ID"
    echo "Region: $REGION"
    echo "Architecture: $arch"
    echo "TPM Support: v2.0"
    echo ""
    echo "Launch with:"
    echo "  aws ec2 run-instances --image-id $AMI_ID \\"
    echo "    --instance-type m5.large \\"
    echo "    --region $REGION"
    echo ""
    
    # Copy PCR measurements if available
    if [ -f "${OUTPUT_DIR}/pcr_measurements.json" ]; then
        log_info "PCR Measurements (for attestation policy):"
        cat "${OUTPUT_DIR}/pcr_measurements.json"
        echo ""
    fi
}

#======================================
# Parse arguments
#--------------------------------------

while [[ $# -gt 0 ]]; do
    case $1 in
        -r|--region)
            REGION="$2"
            shift 2
            ;;
        -n|--name)
            IMAGE_NAME="$2"
            shift 2
            ;;
        -i|--image)
            IMAGE_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

#======================================
# Main
#--------------------------------------

echo "========================================"
echo " Boltz AMI Upload to AWS (coldsnap)"
echo "========================================"
echo ""

# Setup logging
setup_logging

# Run upload steps (with tee to log file)
{
    check_aws_credentials
    install_coldsnap
    find_image
    upload_snapshot
    register_ami
} 2>&1 | tee -a "$LOG_FILE"

log_info "Upload log saved to: $LOG_FILE"

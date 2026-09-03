#!/bin/bash
#=====================================
# Main Build Script for Boltz AMI
# 
# This script orchestrates the kiwi-ng build process
# to create an attestable AMI for AWS.
#=====================================

set -euo pipefail

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$(dirname "$PROJECT_DIR")/app"

# Default configuration
PROFILE="prod"
VERBOSE=false
OUTPUT_DIR="${PROJECT_DIR}/output"
KIWI_DIR="${PROJECT_DIR}/kiwi"
BUILD_DIR="/var/tmp/kiwi-build"
LOGS_DIR="${PROJECT_DIR}/logs"
LOG_FILE=""  # Will be set based on profile and timestamp

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

#======================================
# Functions
#--------------------------------------

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

Build the Boltz Protein Folding AMI using kiwi-ng.

Options:
    -p, --profile PROFILE   Build profile: prod or foa (default: prod)
                           - prod: Production build (no operator access)
                           - foa: Full Operator Access (SSH, SSM, console - DEV/TEST ONLY)
    -o, --output DIR        Output directory (default: ./output)
    -v, --verbose          Enable verbose output
    -c, --clean            Clean build directory before building
    -h, --help             Show this help message

Examples:
    $(basename "$0")                    # Production build (no SSH/SSM)
    $(basename "$0") --profile foa      # FOA build with SSH/SSM (DEV/TEST ONLY)
    $(basename "$0") --verbose --clean  # Verbose clean build
EOF
}

check_dependencies() {
    log_info "Checking dependencies..."
    
    local missing=()
    
    # Check for kiwi-ng
    if ! command -v kiwi-ng &> /dev/null; then
        missing+=("kiwi-ng")
    fi
    
    # Check for required tools
    for cmd in python3 git tar gzip; do
        if ! command -v "$cmd" &> /dev/null; then
            missing+=("$cmd")
        fi
    done
    
    if [ ${#missing[@]} -ne 0 ]; then
        log_error "Missing dependencies: ${missing[*]}"
        log_info "Run ./scripts/install-deps.sh to install dependencies"
        exit 1
    fi
    
    log_info "All dependencies satisfied"
}

prepare_overlay() {
    log_info "Preparing overlay files..."
    
    local overlay_dir="${PROJECT_DIR}/overlay"
    local kiwi_overlay="${KIWI_DIR}/overlay.tar.gz"
    
    # Create overlay directories
    mkdir -p "${overlay_dir}/opt/boltz/app"
    mkdir -p "${overlay_dir}/etc/boltz"
    mkdir -p "${overlay_dir}/etc/systemd/system"
    
    # Copy application files if app directory exists
    # NOTE: Frontend is now hosted on AWS Amplify - only backend is included in the AMI
    if [ -d "$APP_DIR" ]; then
        log_info "Copying backend application files from $APP_DIR"
        log_info "  (Frontend is hosted on AWS Amplify, not included in AMI)"
        cp -r "${APP_DIR}/backend" "${overlay_dir}/opt/boltz/app/" 2>/dev/null || true
        # Frontend removed - now hosted on AWS Amplify at https://main.d181lajk9fhkab.amplifyapp.com
        # cp -r "${APP_DIR}/frontend" "${overlay_dir}/opt/boltz/app/" 2>/dev/null || true
        cp -r "${APP_DIR}/shared" "${overlay_dir}/opt/boltz/app/" 2>/dev/null || true
        cp "${APP_DIR}/requirements.txt" "${overlay_dir}/opt/boltz/app/" 2>/dev/null || true
    else
        log_warn "Application directory not found: $APP_DIR"
    fi
    
    # Create overlay.tar.gz for kiwi-ng
    log_info "Creating overlay.tar.gz archive..."
    cd "${overlay_dir}"
    tar -czvf "${kiwi_overlay}" --owner=root --group=root .
    cd - > /dev/null
    
    log_info "Overlay archive created: ${kiwi_overlay}"
    log_info "Overlay prepared"
}

run_build() {
    log_info "Starting kiwi-ng build..."
    log_info "Output: $OUTPUT_DIR"
    log_info "Log file: $LOG_FILE"
    
    # Build the kiwi-ng command
    # Build the kiwi-ng argv as an array so each element is passed as a distinct
    # argument (no word-splitting of an unquoted command string).
    # Note: Global options (--type, --debug) must come before 'system build'.
    local kiwi_cmd=(kiwi-ng)

    # Add global options
    if [ "$VERBOSE" = true ]; then
        kiwi_cmd+=(--debug)
    fi
    kiwi_cmd+=(--type=oem)
    # Native kiwi profile selection (config.xml defines <profile name="prod"|"foa">).
    kiwi_cmd+=(--profile="$KIWI_PROFILE")

    # Add command and command-specific options
    kiwi_cmd+=(system build --description="$KIWI_DIR" --target-dir="$OUTPUT_DIR")

    log_info "Running: sudo ${kiwi_cmd[*]}"

    # Run kiwi-ng with output to log file
    if [ "$VERBOSE" = true ]; then
        sudo "${kiwi_cmd[@]}" 2>&1 | tee "$LOG_FILE"
    else
        sudo "${kiwi_cmd[@]}" 2>&1 | tee "$LOG_FILE"
    fi

    local exit_code=${PIPESTATUS[0]}

    if [ "$exit_code" -eq 0 ]; then
        log_info "Build completed successfully!"
        log_info "Build log saved to: $LOG_FILE"
    else
        log_error "Build failed with exit code $exit_code"
        log_error "Check log file: $LOG_FILE"
        exit "$exit_code"
    fi
}

clean_build() {
    log_info "Cleaning build directory..."
    
    if [ -d "$BUILD_DIR" ]; then
        sudo rm -rf "$BUILD_DIR"
    fi
    
    if [ -d "$OUTPUT_DIR" ]; then
        rm -rf "$OUTPUT_DIR"
    fi
    
    log_info "Build directory cleaned"
}

create_output_dir() {
    mkdir -p "$OUTPUT_DIR"
    chmod 755 "$OUTPUT_DIR"
    
    # Create logs directory structure
    mkdir -p "${LOGS_DIR}/image-build"
    mkdir -p "${LOGS_DIR}/ami-upload"
}

setup_logging() {
    # Generate timestamped log filename
    local timestamp=$(date +%Y%m%d-%H%M%S)
    LOG_FILE="${LOGS_DIR}/image-build/build-${PROFILE}-${timestamp}.log"
    log_info "Log file: $LOG_FILE"
}

#======================================
# Parse arguments
#--------------------------------------

CLEAN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--profile)
            PROFILE="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -c|--clean)
            CLEAN=true
            shift
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
# Select profile configuration
#--------------------------------------

select_profile() {
    log_info "Selecting profile: $PROFILE"

    # Native kiwi profiles live in a single config.xml (<profile name="prod"|"foa">).
    # No more config-file swapping — just map to the kiwi profile name.
    case "$PROFILE" in
        prod)
            log_info "Building PRODUCTION image (no operator access)"
            KIWI_PROFILE="prod"
            ;;
        foa)
            log_warn "=========================================="
            log_warn "WARNING: Building FOA image - DEV/TEST ONLY"
            log_warn "This image includes SSH, SSM, and console access!"
            log_warn "DO NOT USE IN PRODUCTION"
            log_warn "=========================================="
            KIWI_PROFILE="foa"
            ;;
        *)
            log_error "Unknown profile: $PROFILE (use 'prod' or 'foa')"
            exit 1
            ;;
    esac

    log_info "Using kiwi profile: $KIWI_PROFILE (config: ${KIWI_DIR}/config.xml)"
}

#======================================
# Main
#--------------------------------------

echo "========================================"
echo " Boltz Protein Folding AMI Builder"
echo "========================================"
echo ""

# Check if running as root or with sudo capability
if [ "$EUID" -ne 0 ] && ! sudo -n true 2>/dev/null; then
    log_warn "This script requires sudo access for kiwi-ng"
fi

# Clean if requested
if [ "$CLEAN" = true ]; then
    clean_build
fi

# Select profile and configure
select_profile

# Run build steps
check_dependencies
create_output_dir
setup_logging
prepare_overlay
run_build

echo ""
echo "========================================"
echo " Build Complete!"
echo "========================================"
echo ""
echo "Output files are in: $OUTPUT_DIR"
echo ""
echo "Next steps:"
echo "  1. Upload the .raw image to S3"
echo "  2. Run ./scripts/upload-ami.sh to import to AWS"
echo ""
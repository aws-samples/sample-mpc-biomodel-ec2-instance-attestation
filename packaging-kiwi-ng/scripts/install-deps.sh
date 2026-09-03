#!/bin/bash
#=====================================
# Install Kiwi-NG Build Dependencies
# 
# This script installs all required dependencies for building
# the Boltz protein folding AMI using kiwi-ng.
#=====================================

set -e

echo "Installing kiwi-ng build dependencies..."

# Install all required build dependencies
# Based on: https://github.com/aws-samples/sample-mpc-app-packaging-using-kiwi-ng/blob/main/install.sh
sudo dnf install -y \
    kiwi-cli \
    python3-kiwi \
    kiwi-systemdeps-core \
    python3-poetry-core \
    qemu-img \
    veritysetup \
    erofs-utils \
    git \
    cargo \
    aws-nitro-tpm-tools

echo "All dependencies installed successfully."
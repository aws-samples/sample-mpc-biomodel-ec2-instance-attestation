#!/bin/bash
#=====================================
# Kiwi-NG Post-Config Image Script
# 
# This script runs after config.sh inside the image root.
# It performs final cleanup before the image is sealed.
#=====================================

set -e

# Log execution
echo "[IMAGES.SH] Starting images.sh execution at $(date)" >> /var/log/kiwi-config.log

#======================================
# Source kiwi functions if available
#--------------------------------------
test -f /.kconfig && . /.kconfig
test -f /.profile && . /.profile

#======================================
# Final cleanup
#--------------------------------------
echo "[IMAGES.SH] Performing final cleanup" >> /var/log/kiwi-config.log

# Clear package cache
dnf clean all 2>/dev/null || true

# Clear temp files
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true

# Clear bash history
rm -f /root/.bash_history 2>/dev/null || true
rm -f /home/*/.bash_history 2>/dev/null || true

# Clear log files (except our config log)
find /var/log -type f ! -name "kiwi-config.log" -exec truncate -s 0 {} \; 2>/dev/null || true

echo "[IMAGES.SH] Cleanup completed successfully at $(date)" >> /var/log/kiwi-config.log

exit 0
#!/usr/bin/env bash
# Stop any running EyeType instance.
pkill -f "[e]yetype" 2>/dev/null || true
sleep 0.5
pgrep -af "[e]yetype" || echo "no EyeType processes running"

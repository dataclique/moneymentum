#!/usr/bin/env bash

set -e

# Activate Python venv (devenv does this automatically, but just in case)
# source .venv/bin/activate  # optional if you're not manually activating

# Start frontend (in background)
cd frontend
npm install
npm run dev &

# Start backend
cd ..
python3 server.py

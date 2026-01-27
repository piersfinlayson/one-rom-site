#!/bin/bash
echo "Starting HTTP server..."
echo "Navigate to: http://localhost:8001/"
echo ""
python3 -m http.server 8001 --bind 0.0.0.0

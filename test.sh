#!/bin/bash
echo "Starting HTTP server..."
echo "Navigate to: http://sb1:8000/"
echo ""
python3 -m http.server 8000 --bind 0.0.0.0

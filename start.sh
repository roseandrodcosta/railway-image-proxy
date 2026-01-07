#!/bin/bash

# Configure FlareSolverr to use port 8191 (not the default 8080)
export PORT=8191

# Start FlareSolverr in the background
echo "Starting FlareSolverr on port 8191..."
cd /app
python -u /app/flaresolverr.py &
FLARESOLVERR_PID=$!

# Wait for FlareSolverr to be ready
echo "Waiting for FlareSolverr to start..."
for i in {1..60}; do
  if curl -s http://localhost:8191/health > /dev/null 2>&1; then
    echo "FlareSolverr is ready!"
    break
  fi
  sleep 1
done

# Start the proxy on port 8080 (the externally exposed port)
echo "Starting Image Proxy on port 8080..."
cd /proxy
export FLARESOLVERR_URL=http://localhost:8191/v1
export PORT=8080
node server.js &
PROXY_PID=$!

echo "Both services started!"

# Handle signals for graceful shutdown
trap "kill $FLARESOLVERR_PID $PROXY_PID 2>/dev/null" SIGTERM SIGINT

# Wait for either process to exit
wait -n $FLARESOLVERR_PID $PROXY_PID

# If one exits, kill the other
kill $FLARESOLVERR_PID $PROXY_PID 2>/dev/null

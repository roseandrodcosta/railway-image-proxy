# Combined FlareSolverr + Image Proxy container
# Ensures both services share the SAME external IP for Cloudflare cookie binding

FROM ghcr.io/flaresolverr/flaresolverr:latest

# Install Node.js for the proxy
USER root
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create proxy app directory
WORKDIR /proxy

# Copy proxy code
COPY package.json server.js ./

# Install proxy dependencies
RUN npm install --production

# Copy startup script
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Expose proxy port (FlareSolverr uses 8191 internally)
EXPOSE 8080

# Start both services
CMD ["/start.sh"]

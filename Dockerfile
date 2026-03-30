FROM python:3.11-slim

# Install system deps including Node.js
RUN apt-get update && apt-get install -y \
    git curl build-essential tar \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install opencli-rs — web fetching tool for 55+ sites
RUN curl -fsSL https://github.com/nashsu/opencli-rs/releases/download/v0.1.3/opencli-rs-x86_64-unknown-linux-musl.tar.gz \
    | tar -xz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/opencli-rs \
    && ln -s /usr/local/bin/opencli-rs /usr/local/bin/opencli \
    && opencli-rs --version || true

WORKDIR /app

# Copy repo
COPY . .

# Install Node deps
RUN npm install --omit=dev

# Install Python deps
RUN pip install --no-cache-dir -e ".[messaging,cron,mcp]" || \
    pip install --no-cache-dir -r requirements.txt || true

# Expose port
EXPOSE 8080

# Start the HTTP gateway
CMD ["node", "server.js"]

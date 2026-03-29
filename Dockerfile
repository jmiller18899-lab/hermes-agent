FROM python:3.11-slim

# Install system deps including Node.js
RUN apt-get update && apt-get install -y \
    git curl build-essential \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy repo
COPY . .

# Install Node deps (express + agent-browser)
RUN npm install --omit=dev

# Install Python deps
RUN pip install --no-cache-dir -e ".[messaging,cron,mcp]" || \
    pip install --no-cache-dir -r requirements.txt || true

# Expose port
EXPOSE 8080

# Start the HTTP gateway
CMD ["node", "server.js"]

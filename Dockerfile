FROM python:3.11-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    git curl build-essential nodejs npm \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy repo
COPY . .

# Install Python deps (core + messaging extras for gateway)
RUN pip install --no-cache-dir -e ".[messaging,cron,mcp]" || \
    pip install --no-cache-dir -r requirements.txt

# Install Node deps (agent-browser)
RUN npm install --omit=dev 2>/dev/null || true

# Expose port
EXPOSE 8080

# Start the HTTP gateway server
CMD ["node", "server.js"]

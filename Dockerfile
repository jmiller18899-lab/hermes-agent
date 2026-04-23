FROM debian:bookworm-slim

# Install system deps
RUN apt-get update && apt-get install -y \
    curl bash git nodejs npm python3 python3-pip \
    ripgrep ffmpeg gcc python3-dev libffi-dev ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Set HOME so install script puts hermes in /data/.hermes/hermes-agent
ENV HOME=/data
ENV HERMES_HOME=/data/.hermes
RUN mkdir -p /data

# Install Hermes using the official install script (non-interactive)
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --no-venv --skip-setup || true

# Copy our gateway files alongside the installed hermes
COPY server.js /data/.hermes/hermes-agent/server.js
COPY hermes_runner.py /data/.hermes/hermes-agent/hermes_runner.py
COPY package.json /data/.hermes/hermes-agent/package.json

# Install Node deps
RUN cd /data/.hermes/hermes-agent && npm install --omit=dev

ENV HERMES_DIR=/data/.hermes/hermes-agent
ENV HERMES_RUNNER=/data/.hermes/hermes-agent/hermes_runner.py
ENV PORT=8080

WORKDIR /data/.hermes/hermes-agent
EXPOSE 8080

CMD ["node", "server.js"]

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl bash git nodejs npm python3 python3-pip \
    ripgrep ffmpeg gcc python3-dev libffi-dev \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

# Install Hermes using the official install script.
# Download first, then run with stdin from /dev/null to prevent the interactive
# setup wizard from failing the build (it reads from /dev/tty which does not
# exist in Docker). The || true suppresses the wizard exit code while the
# final test ensures the real installation actually completed.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/install.sh \
    && chmod +x /tmp/install.sh \
    && bash /tmp/install.sh < /dev/null || true \
    && rm -f /tmp/install.sh \
    && test -d /root/.hermes/hermes-agent

# Copy our custom gateway files on top
WORKDIR /opt/hermes
COPY server.js .
COPY hermes_runner.py .
COPY package.json .

# Install Node deps (express)
RUN npm install --omit=dev

# Create data dir
RUN mkdir -p /data/.hermes

ENV HERMES_HOME=/data
ENV HERMES_DIR=/opt/hermes
ENV HERMES_RUNNER=/opt/hermes/hermes_runner.py
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]

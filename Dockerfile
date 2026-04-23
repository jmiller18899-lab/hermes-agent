FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl bash git nodejs npm python3 python3-pip \
    ripgrep gcc python3-dev libffi-dev ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/data
ENV HERMES_HOME=/data/.hermes
RUN mkdir -p /data

# Clone Hermes and install all deps from requirements.txt
RUN git clone --depth=1 https://github.com/NousResearch/hermes-agent /data/.hermes/hermes-agent \
    && pip3 install --break-system-packages -r /data/.hermes/hermes-agent/requirements.txt \
    && pip3 install --break-system-packages -e /data/.hermes/hermes-agent \
    || pip3 install --break-system-packages \
       openai anthropic httpx mcp requests fire rich click pydantic \
       python-dotenv aiohttp websockets tiktoken

# Copy our gateway files
COPY server.js /data/.hermes/hermes-agent/server.js
COPY hermes_runner.py /data/.hermes/hermes-agent/hermes_runner.py
COPY package.json /data/.hermes/hermes-agent/package.json

RUN cd /data/.hermes/hermes-agent && npm install --omit=dev

ENV HERMES_DIR=/data/.hermes/hermes-agent
ENV HERMES_RUNNER=/data/.hermes/hermes-agent/hermes_runner.py
ENV PATH="/data/.hermes/bin:/data/.hermes/hermes-agent/.venv/bin:${PATH}"
ENV PORT=8080

WORKDIR /data/.hermes/hermes-agent
EXPOSE 8080
CMD ["node", "server.js"]

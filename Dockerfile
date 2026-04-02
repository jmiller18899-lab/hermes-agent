FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    nodejs npm python3 python3-pip ripgrep ffmpeg gcc python3-dev libffi-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY . /opt/hermes
WORKDIR /opt/hermes

# Install Python hermes package
RUN pip install -e ".[all]" --break-system-packages || \
    pip install -e "." --break-system-packages

# Install Node deps
RUN npm install --omit=dev

# Install opencli-rs
RUN curl -fsSL https://github.com/nashsu/opencli-rs/releases/download/v0.1.3/opencli-rs-x86_64-unknown-linux-musl.tar.gz \
    | tar -xz -C /usr/local/bin/ && chmod +x /usr/local/bin/opencli-rs 2>/dev/null || true

ENV HERMES_HOME=/opt/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "/opt/hermes/server.js"]

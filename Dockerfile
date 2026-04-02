FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    nodejs npm python3 python3-pip ripgrep ffmpeg gcc python3-dev libffi-dev curl \
    && rm -rf /var/lib/apt/lists/*

COPY . /opt/hermes
WORKDIR /opt/hermes

# Install Python hermes package
RUN pip install -e "." --break-system-packages || \
    pip install -r requirements.txt --break-system-packages || true

# Install Node deps (express)
RUN npm install --omit=dev

ENV HERMES_HOME=/opt/data
ENV HERMES_DIR=/opt/hermes
ENV HERMES_RUNNER=/opt/hermes/hermes_runner.py
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]

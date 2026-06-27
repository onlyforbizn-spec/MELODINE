FROM python:3.12-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Worker gthread : gère bien mieux les gros uploads que le worker sync.
# --timeout 300 et --graceful-timeout 300 pour ne jamais couper en plein upload.
CMD gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --threads 4 --worker-class gthread --timeout 300 --graceful-timeout 300

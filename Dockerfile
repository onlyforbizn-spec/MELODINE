FROM python:3.12-slim

# FFmpeg est requis pour la découpe audio
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Railway injecte $PORT au runtime ; gunicorn doit l'écouter.
# --timeout 180 car le ré-encodage d'un MP3 peut prendre quelques secondes.
CMD gunicorn app:app --bind 0.0.0.0:$PORT --workers 2 --timeout 180

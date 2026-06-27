import os
import subprocess
import tempfile
import requests
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# Durée de l'extrait en secondes (30 premières secondes)
PREVIEW_SECONDS = int(os.environ.get("PREVIEW_SECONDS", "30"))


@app.route("/")
def health():
    """Health check — Railway pingue cette route pour vérifier que le service tourne."""
    return jsonify({"status": "ok", "service": "melodine-audio"}), 200


@app.route("/trim", methods=["POST"])
def trim():
    """
    Reçoit un MP3 complet (binaire dans le champ 'data'), coupe les
    PREVIEW_SECONDS premières secondes, et renvoie l'extrait en binaire.

    Accepte deux modes :
    - multipart/form-data avec un fichier nommé 'data'
    - ou un JSON { "url": "https://..." } pour télécharger le MP3 depuis une URL
    """
    in_path = None
    out_path = None
    try:
        # Cas 1 : fichier envoyé directement (n8n "n8n Binary File" -> champ 'data')
        if "data" in request.files:
            f = request.files["data"]
            fd_in, in_path = tempfile.mkstemp(suffix=".mp3")
            os.close(fd_in)
            f.save(in_path)

        # Cas 2 : URL passée en JSON
        elif request.is_json and request.json.get("url"):
            url = request.json["url"]
            r = requests.get(url, timeout=120)
            r.raise_for_status()
            fd_in, in_path = tempfile.mkstemp(suffix=".mp3")
            os.close(fd_in)
            with open(in_path, "wb") as out:
                out.write(r.content)
        else:
            return jsonify({"error": "No file 'data' and no 'url' provided"}), 400

        # Découpe les N premières secondes avec FFmpeg (ré-encodage propre)
        fd_out, out_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd_out)

        cmd = [
            "ffmpeg", "-y",
            "-i", in_path,
            "-t", str(PREVIEW_SECONDS),
            "-acodec", "libmp3lame",
            "-b:a", "192k",
            out_path,
        ]
        result = subprocess.run(cmd, capture_output=True)
        if result.returncode != 0:
            return jsonify({
                "error": "ffmpeg failed",
                "details": result.stderr.decode("utf-8", "ignore")[-1000:],
            }), 500

        return send_file(
            out_path,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name="extrait.mp3",
        )

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        for p in (in_path,):
            if p and os.path.exists(p):
                try:
                    os.remove(p)
                except OSError:
                    pass
        # out_path est supprimé après l'envoi par after_request ci-dessous
        if out_path:
            app.config["_LAST_OUT"] = out_path


@app.after_request
def cleanup(response):
    """Nettoie le fichier de sortie temporaire après envoi."""
    out_path = app.config.pop("_LAST_OUT", None)
    if out_path and os.path.exists(out_path):
        try:
            os.remove(out_path)
        except OSError:
            pass
    return response


if __name__ == "__main__":
    # En local. En prod Railway utilise gunicorn (voir Procfile).
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)

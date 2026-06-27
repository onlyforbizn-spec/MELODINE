import os
import subprocess
import tempfile
import requests
from flask import Flask, request, send_file, jsonify

app = Flask(__name__)

# Autorise les gros uploads (jusqu'à 100 Mo) — un MP3 Suno fait ~5-6 Mo.
app.config["MAX_CONTENT_LENGTH"] = 100 * 1024 * 1024

# Durée de l'extrait en secondes (30 premières secondes)
PREVIEW_SECONDS = int(os.environ.get("PREVIEW_SECONDS", "30"))


@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "melodine-audio"}), 200


@app.route("/trim", methods=["POST"])
def trim():
    in_path = None
    out_path = None
    try:
        fd_in, in_path = tempfile.mkstemp(suffix=".mp3")
        os.close(fd_in)
        got_input = False

        if "data" in request.files:
            request.files["data"].save(in_path)
            got_input = True
        elif request.is_json and request.json.get("url"):
            r = requests.get(request.json["url"], timeout=180)
            r.raise_for_status()
            with open(in_path, "wb") as out:
                out.write(r.content)
            got_input = True
        else:
            raw = request.get_data()
            if raw:
                with open(in_path, "wb") as out:
                    out.write(raw)
                got_input = True

        if not got_input or os.path.getsize(in_path) == 0:
            return jsonify({"error": "No audio received"}), 400

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

        response = send_file(
            out_path,
            mimetype="audio/mpeg",
            as_attachment=True,
            download_name="extrait.mp3",
        )
        app.config["_LAST_OUT"] = out_path
        out_path = None
        return response

    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        if in_path and os.path.exists(in_path):
            try:
                os.remove(in_path)
            except OSError:
                pass
        if out_path and os.path.exists(out_path):
            try:
                os.remove(out_path)
            except OSError:
                pass


@app.after_request
def cleanup(response):
    out_path = app.config.pop("_LAST_OUT", None)
    if out_path and os.path.exists(out_path):
        try:
            os.remove(out_path)
        except OSError:
            pass
    return response


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    app.run(host="0.0.0.0", port=port)

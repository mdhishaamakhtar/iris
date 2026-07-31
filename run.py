"""Web entrypoint. Gunicorn imports ``app``; ``python run.py`` runs it locally."""

import os

from app import create_app

app = create_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 9020)), debug=app.debug)

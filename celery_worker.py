"""Celery entrypoint: ``celery -A celery_worker.celery worker``.

Creating the app registers the tasks and installs the app-context task base, so
workers share the web process's configuration and services.
"""

from app import celery, create_app

flask_app = create_app()
flask_app.app_context().push()

__all__ = ["celery"]

"""Settings resolution: defaults, per-environment overrides, and validation."""

from __future__ import annotations

from dataclasses import replace

import pytest

from app.config import Settings
from app.errors import ConfigError


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """Start from a bare environment so a developer's .env cannot skew results."""
    for name in (
        "SECRET_KEY",
        "REDIS_URL",
        "MAX_SEARCH_DEPTH",
        "FLASK_ENV",
        "LOG_LEVEL",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SECRET_KEY", "a" * 40)


def test_defaults_to_development(monkeypatch):
    assert Settings.from_env().env == "development"


def test_an_unrecognised_environment_falls_back_to_development(monkeypatch):
    monkeypatch.setenv("FLASK_ENV", "staging")
    assert Settings.from_env().env == "development"


def test_environment_defaults_apply(monkeypatch):
    monkeypatch.setenv("FLASK_ENV", "production")

    production = Settings.from_env()

    assert production.max_search_depth == 6
    assert production.log_level == "INFO"
    assert Settings.from_env("development").max_search_depth == 4


def test_an_environment_variable_beats_the_environment_default(monkeypatch):
    monkeypatch.setenv("MAX_SEARCH_DEPTH", "9")
    assert Settings.from_env("development").max_search_depth == 9


def test_numeric_overrides_are_parsed_to_numbers(monkeypatch):
    monkeypatch.setenv("MAX_SEARCH_DEPTH", "8")
    monkeypatch.setenv("WIKIPEDIA_REQUEST_DELAY", "0.25")

    settings = Settings.from_env()

    assert settings.max_search_depth == 8
    assert settings.wikipedia_request_delay == 0.25


def test_debug_and_testing_follow_the_environment():
    assert Settings.from_env("development").debug is True
    assert Settings.from_env("testing").testing is True
    assert Settings.from_env("production").debug is False


VALID = Settings(secret_key="ok")


@pytest.mark.parametrize(
    ("broken", "message"),
    [
        (replace(VALID, secret_key=""), "SECRET_KEY is required"),
        (replace(VALID, redis_url="http://localhost"), "REDIS_URL"),
        (replace(VALID, max_search_depth=0), "MAX_SEARCH_DEPTH"),
        (replace(VALID, wikipedia_timeout=0), "WIKIPEDIA_TIMEOUT"),
    ],
)
def test_rejects_invalid_settings(broken, message):
    with pytest.raises(ConfigError, match=message):
        broken.validate()


def test_production_demands_a_strong_secret_key():
    with pytest.raises(ConfigError, match="at least 32 characters"):
        Settings(env="production", secret_key="short").validate()


def test_a_short_secret_key_is_fine_outside_production():
    Settings(env="development", secret_key="short").validate()

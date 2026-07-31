"""The Wikipedia client, driven by a stub HTTP session.

Only ``requests`` is faked. Parsing, pagination, caching, retry and the rate
limiter all run for real.
"""

from __future__ import annotations

from dataclasses import replace

import pytest
import requests

from app.config import Settings
from app.errors import WikipediaAPIError
from app.wikipedia import WikipediaClient


class FakeResponse:
    def __init__(
        self,
        payload: dict | None = None,
        status: int = 200,
        headers: dict | None = None,
    ):
        self._payload = payload or {}
        self.status_code = status
        self.headers = headers or {}

    @property
    def ok(self) -> bool:
        return self.status_code < 400

    def json(self) -> dict:
        return self._payload


class FakeSession:
    """Replays a queued list of responses and records the params it was sent."""

    def __init__(self, *responses: FakeResponse | Exception):
        self.responses = list(responses)
        self.requests: list[dict] = []
        self.headers: dict[str, str] = {}

    def get(self, url: str, params: dict, timeout: int) -> FakeResponse:
        self.requests.append(params)
        result = self.responses.pop(0) if self.responses else FakeResponse()
        if isinstance(result, Exception):
            raise result
        return result


def links_payload(title: str, titles: list[str], **extra) -> dict:
    return {
        "query": {
            "pages": {"1": {"title": title, "links": [{"title": t} for t in titles]}}
        },
        **extra,
    }


@pytest.fixture
def settings() -> Settings:
    return Settings(
        env="testing",
        secret_key="test",
        wikipedia_request_delay=0,
        wikipedia_max_retries=3,
        wikipedia_max_pages=3,
    )


def build(settings: Settings, session: FakeSession, cache=None) -> WikipediaClient:
    return WikipediaClient(settings, cache=cache, session=session)


# --- Parsing --------------------------------------------------------------


def test_keeps_articles_and_drops_other_namespaces(settings):
    session = FakeSession(
        FakeResponse(
            links_payload(
                "Python", ["Programming", "Category:Languages", "File:Snake.png"]
            )
        )
    )
    assert build(settings, session).links(["Python"]) == {"Python": ["Programming"]}


def test_keeps_list_of_pages_despite_their_colon(settings):
    session = FakeSession(FakeResponse(links_payload("Python", ["List of: things"])))
    assert build(settings, session).links(["Python"]) == {"Python": ["List of: things"]}


def test_follows_redirects_back_to_the_requested_title(settings):
    """The API answers under the resolved title; callers asked for the original."""
    payload = links_payload("Python (programming language)", ["Programming"])
    payload["query"]["redirects"] = [
        {"from": "Python lang", "to": "Python (programming language)"}
    ]
    session = FakeSession(FakeResponse(payload))

    assert build(settings, session).links(["Python lang"]) == {
        "Python lang": ["Programming"]
    }


def test_missing_pages_yield_no_links(settings):
    session = FakeSession(
        FakeResponse({"query": {"pages": {"-1": {"title": "X", "missing": ""}}}})
    )
    assert build(settings, session).links(["X"]) == {"X": []}


def test_reads_backlinks_from_their_own_response_shape(settings):
    session = FakeSession(
        FakeResponse({"query": {"backlinks": [{"title": "A"}, {"title": "Talk:B"}]}})
    )
    assert build(settings, session).backlinks(["X"]) == {"X": ["A"]}


# --- Pagination -----------------------------------------------------------


def test_follows_continuations(settings):
    session = FakeSession(
        FakeResponse(
            links_payload(
                "P", ["A"], **{"continue": {"plcontinue": "c1", "continue": "||"}}
            )
        ),
        FakeResponse(links_payload("P", ["B"])),
    )

    assert build(settings, session).links(["P"]) == {"P": ["A", "B"]}
    assert session.requests[1]["plcontinue"] == "c1"


def test_stops_paginating_at_the_configured_limit(settings):
    endless = FakeResponse(
        links_payload("P", ["A"], **{"continue": {"plcontinue": "c", "continue": "||"}})
    )
    session = FakeSession(*[endless] * 10)

    build(replace(settings, wikipedia_max_pages=2), session).links(["P"])

    assert len(session.requests) == 2


# --- Caching --------------------------------------------------------------


def test_caches_results_and_serves_repeats_without_hitting_the_api(settings, store):
    session = FakeSession(FakeResponse(links_payload("Python", ["Programming"])))
    client = build(settings, session, cache=store)

    assert client.links(["Python"]) == {"Python": ["Programming"]}
    assert client.links(["Python"]) == {"Python": ["Programming"]}
    assert len(session.requests) == 1


def test_only_fetches_the_pages_that_are_not_cached(settings, store):
    store.set("wiki_links:Cached", ["Known"])
    session = FakeSession(FakeResponse(links_payload("Fresh", ["New"])))

    result = build(settings, session, cache=store).links(["Cached", "Fresh"])

    assert result == {"Cached": ["Known"], "Fresh": ["New"]}
    assert len(session.requests) == 1


def test_reports_cached_pages_to_the_progress_callback_too(settings, store):
    store.set("wiki_links:Cached", ["Known"])
    seen: list[str] = []

    build(settings, FakeSession(), cache=store).links(
        ["Cached"], lambda title, _links: seen.append(title)
    )

    assert seen == ["Cached"]


def test_forward_and_backward_caches_do_not_collide(settings, store):
    store.set("wiki_links:X", ["forward-only"])
    session = FakeSession(FakeResponse({"query": {"backlinks": [{"title": "B"}]}}))

    assert build(settings, session, cache=store).backlinks(["X"]) == {"X": ["B"]}


# --- Failures -------------------------------------------------------------


def test_retries_server_errors_then_succeeds(settings):
    session = FakeSession(
        FakeResponse(status=503),
        FakeResponse(links_payload("P", ["A"])),
    )
    assert build(settings, session).links(["P"]) == {"P": ["A"]}


def test_respects_retry_after_on_rate_limiting(settings, monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr("app.wikipedia.time.sleep", slept.append)

    session = FakeSession(
        FakeResponse(status=429, headers={"Retry-After": "7"}),
        FakeResponse(links_payload("P", ["A"])),
    )
    build(settings, session).links(["P"])

    assert slept == [7]


def test_retries_network_failures(settings, monkeypatch):
    monkeypatch.setattr("app.wikipedia.time.sleep", lambda _s: None)
    session = FakeSession(
        requests.ConnectionError("boom"),
        FakeResponse(links_payload("P", ["A"])),
    )
    assert build(settings, session).links(["P"]) == {"P": ["A"]}


def test_gives_up_after_the_retry_budget(settings, monkeypatch):
    monkeypatch.setattr("app.wikipedia.time.sleep", lambda _s: None)
    session = FakeSession(*[FakeResponse(status=500)] * 3)

    with pytest.raises(WikipediaAPIError, match="after 3 attempts"):
        build(settings, session).links(["P"])

    assert len(session.requests) == 3


def test_does_not_retry_client_errors(settings):
    session = FakeSession(FakeResponse(status=400))

    with pytest.raises(WikipediaAPIError, match="rejected"):
        build(settings, session).links(["P"])

    assert len(session.requests) == 1, "a 400 will never become a 200"


# --- Page status ----------------------------------------------------------


def test_reports_an_existing_page(settings):
    session = FakeSession(
        FakeResponse({"query": {"pages": {"1": {"title": "Python"}}}})
    )
    status = build(settings, session).page_status("Python")

    assert status.exists and not status.is_disambiguation


def test_reports_a_missing_page(settings):
    session = FakeSession(FakeResponse({"query": {"pages": {"-1": {"missing": ""}}}}))
    assert build(settings, session).page_status("Nope").exists is False


def test_detects_disambiguation_by_category(settings):
    session = FakeSession(
        FakeResponse(
            {
                "query": {
                    "pages": {
                        "1": {
                            "title": "Mercury",
                            "categories": [{"title": "Category:Disambiguation pages"}],
                        }
                    }
                }
            }
        )
    )
    assert build(settings, session).page_status("Mercury").is_disambiguation is True


def test_detects_disambiguation_by_title(settings):
    session = FakeSession(
        FakeResponse({"query": {"pages": {"1": {"title": "Mercury (disambiguation)"}}}})
    )
    assert build(settings, session).page_status("Mercury").is_disambiguation is True


def test_reports_where_a_redirect_lands(settings):
    session = FakeSession(
        FakeResponse(
            {
                "query": {
                    "redirects": [{"from": "NYC", "to": "New York City"}],
                    "pages": {"1": {"title": "New York City"}},
                }
            }
        )
    )
    assert build(settings, session).page_status("NYC").resolved_title == "New York City"


# --- Rate limiting --------------------------------------------------------


def test_spaces_requests_by_the_configured_delay(monkeypatch):
    waits: list[float] = []
    monkeypatch.setattr("app.wikipedia.time.sleep", waits.append)

    settings = Settings(env="testing", secret_key="t", wikipedia_request_delay=0.5)
    client = build(settings, FakeSession(FakeResponse(), FakeResponse()))

    client._await_rate_slot()
    client._await_rate_slot()

    assert waits and waits[0] > 0, "the second call must wait out the interval"

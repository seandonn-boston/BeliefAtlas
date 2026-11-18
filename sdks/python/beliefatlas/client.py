"""The client: question cards, placements, splits, and the (switched off) server relay."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Tuple

API_VERSION = 1
CHOICES = ("true", "false", "unsure", "skip")

# A transport takes (method, url, headers, body) and returns (status, body bytes). The default
# uses urllib; tests and frameworks with their own HTTP client can pass another.
Transport = Callable[[str, str, Mapping[str, str], Optional[bytes]], Tuple[int, bytes]]


class BeliefAtlasError(Exception):
    """A request BeliefAtlas refused or couldn't answer."""

    def __init__(self, message: str, status: int = 0, code: str = "http_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _urllib_transport(timeout: float) -> Transport:
    def send(method: str, url: str, headers: Mapping[str, str], body: Optional[bytes]) -> Tuple[int, bytes]:
        req = urllib.request.Request(url, data=body, method=method, headers=dict(headers))
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (https or http only, checked below)
                return res.status, res.read()
        except urllib.error.HTTPError as err:
            return err.code, err.read()
        except (urllib.error.URLError, OSError) as err:
            raise BeliefAtlasError(f"BeliefAtlas could not be reached: {err}", 0, "network") from err

    return send


class BeliefAtlas:
    """Talks to one BeliefAtlas deployment's /api/headless/v1.

    base_url     BeliefAtlas's address.
    placement    your placement id ("pl-..."), to label answers and read your placement.
    lang         reader language, e.g. "es".
    origin       your page's origin, to be told when a hosted tap counts (web pages only).
    credential   an org server key (cm_live_...) for the relay or results (switched off on
                 BeliefAtlas's side). Keep it on your server.
    """

    def __init__(
        self,
        base_url: str,
        *,
        placement: Optional[str] = None,
        lang: Optional[str] = None,
        origin: Optional[str] = None,
        credential: Optional[str] = None,
        timeout: float = 10.0,
        transport: Optional[Transport] = None,
    ) -> None:
        if not base_url:
            raise ValueError("base_url is required")
        scheme = urllib.parse.urlsplit(base_url).scheme
        if scheme not in ("https", "http"):
            raise ValueError("base_url must be an https (or local http) address")
        self.base_url = base_url.rstrip("/")
        self.placement_id = placement
        self.lang = lang
        self.origin = origin
        self._credential = credential
        self._send = transport or _urllib_transport(timeout)

    def __repr__(self) -> str:  # never print the credential
        return f"BeliefAtlas(base_url={self.base_url!r}, placement={self.placement_id!r})"

    # ---------- plumbing ----------

    def _api(self, path: str, params: Optional[Dict[str, Optional[str]]] = None) -> str:
        url = f"{self.base_url}/api/headless/v{API_VERSION}{path}"
        query = {k: v for k, v in (params or {}).items() if v}
        return f"{url}?{urllib.parse.urlencode(query)}" if query else url

    def _request(self, method: str, url: str, body: Optional[dict] = None, headers: Optional[Dict[str, str]] = None) -> Any:
        h = {"Accept": "application/json", **(headers or {})}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            h["Content-Type"] = "application/json"
        status, raw = self._send(method, url, h, data)
        try:
            parsed = json.loads(raw.decode("utf-8")) if raw else None
        except ValueError:
            parsed = None
        if status >= 400 and not (isinstance(parsed, dict) and "outcome" in parsed):
            info = parsed if isinstance(parsed, dict) else {}
            raise BeliefAtlasError(info.get("message") or f"BeliefAtlas answered {status}", status, info.get("error") or "http_error")
        return parsed

    # ---------- reading ----------

    def question(self, question_id: int, *, lang: Optional[str] = None) -> dict:
        """One question card (no split: show it after an answer counted)."""
        return self._request("GET", self._api(f"/questions/{int(question_id)}", {
            "lang": lang or self.lang, "placement": self.placement_id, "origin": self.origin,
        }))

    def placement(self, *, lang: Optional[str] = None) -> dict:
        """Your placement and its question cards, in order."""
        if not self.placement_id:
            raise ValueError("placement is required")
        return self._request("GET", self._api(f"/placements/{urllib.parse.quote(self.placement_id)}", {
            "lang": lang or self.lang, "origin": self.origin,
        }))

    def split(self, question_id: int, *, lang: Optional[str] = None) -> dict:
        """Percentages only, with the unofficial notice."""
        return self._request("GET", self._api(f"/questions/{int(question_id)}/split", {"lang": lang or self.lang}))

    # ---------- server relay (switched off on BeliefAtlas's side) ----------

    def relay_vote(
        self,
        *,
        user_id: str,
        question_id: int,
        value: str,
        idempotency_key: str,
        shown: Optional[str] = None,
        lang: Optional[str] = None,
    ) -> dict:
        """Send a tap made in your own UI for your linked user. Returns the outcome dict.

        user_id is your own opaque id for the person, never an email or phone number.
        idempotency_key is your id for this interaction; reuse it when you retry.
        """
        if not self._credential:
            raise BeliefAtlasError("relay_vote needs an organization credential.", 0, "unauthorized")
        if not self.placement_id:
            raise ValueError("placement is required")
        if value not in CHOICES:
            raise ValueError(f"value must be one of {CHOICES}")
        if not idempotency_key:
            raise ValueError("idempotency_key is required")
        body = {
            "placementId": self.placement_id, "userId": user_id, "questionId": int(question_id),
            "value": value, "idempotencyKey": idempotency_key,
        }
        if shown:
            body["shown"] = shown
        if lang:
            body["lang"] = lang
        return self._request("POST", self._api("/votes"), body, {"Authorization": f"Bearer {self._credential}"})

    def results(self, *, lang: Optional[str] = None) -> dict:
        """Your placement's aggregate results, read with a key that has the results scope.

        Small groups are hidden and nothing is person-level. Keys are switched off on BeliefAtlas's
        side until it's decided.
        """
        if not self._credential:
            raise BeliefAtlasError("results needs an organization key with the results scope.", 0, "unauthorized")
        if not self.placement_id:
            raise ValueError("placement is required")
        return self._request("GET", self._api(f"/placements/{urllib.parse.quote(self.placement_id)}/results", {
            "lang": lang or self.lang,
        }), None, {"Authorization": f"Bearer {self._credential}"})


def answer_url(card: Mapping[str, Any], value: str) -> Optional[str]:
    """The hosted-tap link for one choice: BeliefAtlas's vote page with that answer highlighted.
    Opening it never votes. None when the question is closed."""
    for choice in card.get("choices", []):
        if choice.get("value") == value:
            return choice.get("answerUrl")
    return None


@dataclass(frozen=True)
class Described:
    tone: str          # "done" | "info" | "action" | "error"
    text: str
    link_url: Optional[str] = None


def describe_outcome(outcome: Mapping[str, Any], fallback_url: Optional[str] = None) -> Described:
    """What to show for any relay outcome, in plain English. Unknown outcomes send people to BeliefAtlas."""
    kind = outcome.get("outcome")
    msg = outcome.get("message")
    link = outcome.get("linkUrl")
    table = {
        "cast": Described("done", "Counted. Thanks for answering."),
        "same": Described("done", "You already gave that answer."),
        "changed": Described("done", "Your answer was changed."),
        "skipped": Described("info", "Skipped."),
        "needs_link": Described("action", "Link your BeliefAtlas account to answer here.", link),
        "needs_consent": Described("action", "Agree to BeliefAtlas's terms for answering, then your answer counts.", link),
        "limit_reached": Described("info", msg or "That's all the answers for today."),
        "change_used": Described("info", msg or "You can change this answer again tomorrow."),
        "closed": Described("info", msg or "This question is closed to new answers."),
        "slow_down": Described("error", msg or "Too many answers at once. Try again in a minute."),
        "invalid": Described("error", msg or "That answer couldn't be sent."),
        "forbidden": Described("error", msg or "That answer couldn't be sent."),
    }
    return table.get(kind, Described("action", "Answer on BeliefAtlas.", link or fallback_url))

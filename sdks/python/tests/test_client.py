"""Unit tests against the shared contract (sdks/contract/v1.json), with a stub transport:
no network, test data only."""

import json
import os
import unittest
from pathlib import Path

from beliefatlas import BeliefAtlas, BeliefAtlasError, answer_url, describe_outcome, render_card_html

CONTRACT = json.loads((Path(__file__).resolve().parents[2] / "contract" / "v1.json").read_text())
BASE = "https://beliefatlas.example.test"


class Stub:
    """Records requests and answers from a table of (method, path) -> (status, body)."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((method, url, dict(headers), json.loads(body) if body else None))
        path = url.split("?", 1)[0].replace(BASE, "")
        status, payload = self.routes.get((method, path), (404, {"error": "not_found", "message": "Not found."}))
        return status, json.dumps(payload).encode()


class ReadingTests(unittest.TestCase):
    def test_question_sends_placement_lang_and_origin(self):
        stub = Stub({("GET", "/api/headless/v1/questions/123"): (200, CONTRACT["card"])})
        cm = BeliefAtlas(BASE + "/", placement="pl-abcdefghjk23", lang="es", origin="https://shop.example.test", transport=stub)
        card = cm.question(123)
        self.assertEqual(card["id"], 123)
        url = stub.calls[0][1]
        self.assertIn("placement=pl-abcdefghjk23", url)
        self.assertIn("lang=es", url)
        self.assertIn("origin=https%3A%2F%2Fshop.example.test", url)
        self.assertNotIn("percentages", card, "cards carry no split")

    def test_placement_and_split(self):
        stub = Stub({
            ("GET", "/api/headless/v1/placements/pl-abcdefghjk23"): (200, CONTRACT["placement"]),
            ("GET", "/api/headless/v1/questions/123/split"): (200, CONTRACT["split"]),
        })
        cm = BeliefAtlas(BASE, placement="pl-abcdefghjk23", transport=stub)
        self.assertEqual(cm.placement()["placement"]["kind"], "site")
        self.assertEqual(set(cm.split(123)), {"questionId", "hasVotes", "percentages"})

    def test_errors_raise_with_status_and_code(self):
        cm = BeliefAtlas(BASE, transport=Stub({}))
        with self.assertRaises(BeliefAtlasError) as caught:
            cm.question(5)
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "not_found")

    def test_base_url_must_be_web(self):
        with self.assertRaises(ValueError):
            BeliefAtlas("ftp://example.test")

    def test_repr_hides_the_credential(self):
        self.assertNotIn("s3cret", repr(BeliefAtlas(BASE, credential="s3cret-value-0123456789")))


class RelayTests(unittest.TestCase):
    def test_relay_posts_json_with_the_credential(self):
        stub = Stub({("POST", "/api/headless/v1/votes"): (200, CONTRACT["relayOutcomes"]["cast"])})
        cm = BeliefAtlas(BASE, placement="pl-abcdefghjk23", credential="test-cred-0123456789", transport=stub)
        out = cm.relay_vote(user_id="cust-42", question_id=123, value="true", idempotency_key="tx-1", shown="123.1.x")
        self.assertEqual(out["outcome"], "cast")
        method, _url, headers, body = stub.calls[0]
        self.assertEqual(method, "POST")
        self.assertEqual(headers["Authorization"], "Bearer test-cred-0123456789")
        self.assertEqual(body, {
            "placementId": "pl-abcdefghjk23", "userId": "cust-42", "questionId": 123,
            "value": "true", "idempotencyKey": "tx-1", "shown": "123.1.x",
        })

    def test_outcomes_with_error_status_come_back_as_outcomes(self):
        stub = Stub({("POST", "/api/headless/v1/votes"): (429, CONTRACT["relayOutcomes"]["slow_down"])})
        cm = BeliefAtlas(BASE, placement="pl-abcdefghjk23", credential="test-cred-0123456789", transport=stub)
        self.assertEqual(cm.relay_vote(user_id="u", question_id=123, value="true", idempotency_key="k")["outcome"], "slow_down")

    def test_relay_needs_a_credential_a_key_and_a_real_choice(self):
        cm = BeliefAtlas(BASE, placement="pl-abcdefghjk23", transport=Stub({}))
        with self.assertRaises(BeliefAtlasError):
            cm.relay_vote(user_id="u", question_id=1, value="true", idempotency_key="k")
        cm = BeliefAtlas(BASE, placement="pl-abcdefghjk23", credential="c" * 20, transport=Stub({}))
        with self.assertRaises(ValueError):
            cm.relay_vote(user_id="u", question_id=1, value="maybe", idempotency_key="k")
        with self.assertRaises(ValueError):
            cm.relay_vote(user_id="u", question_id=1, value="true", idempotency_key="")


class DrawingTests(unittest.TestCase):
    def test_every_contract_outcome_has_words(self):
        for name, outcome in CONTRACT["relayOutcomes"].items():
            d = describe_outcome(outcome)
            self.assertTrue(d.text, name)
            if name in ("needs_link", "needs_consent"):
                self.assertTrue(d.link_url, name)
        self.assertEqual(describe_outcome({"outcome": "new_thing"}, "https://x.test/v/1").link_url, "https://x.test/v/1")

    def test_render_escapes_and_links_each_choice(self):
        card = dict(CONTRACT["card"], text='Is <b>"this"</b> & that true?')
        html = render_card_html(card)
        self.assertIn("Is &lt;b&gt;&quot;this&quot;&lt;/b&gt; &amp; that true?", html)
        self.assertEqual(html.count('class="beliefatlas-choice '), 4)
        self.assertEqual(answer_url(card, "skip"), CONTRACT["card"]["choices"][3]["answerUrl"])

    def test_closed_card(self):
        card = dict(CONTRACT["card"], status="archived", choices=[dict(c, answerUrl=None) for c in CONTRACT["card"]["choices"]])
        self.assertIn("closed to new answers", render_card_html(card))
        self.assertIsNone(answer_url(card, "true"))


@unittest.skipUnless(os.environ.get("BELIEFATLAS_LIVE_BASE_URL") and os.environ.get("BELIEFATLAS_LIVE_PLACEMENT"),
                     "live test: set BELIEFATLAS_LIVE_BASE_URL and BELIEFATLAS_LIVE_PLACEMENT (test data only)")
class LiveTests(unittest.TestCase):
    """Against a running development server with HEADLESS_ENABLED=true and the test data from
    scripts/headless/test-data.ts. Never point it at production."""

    def test_live_round_trip(self):
        cm = BeliefAtlas(os.environ["BELIEFATLAS_LIVE_BASE_URL"], placement=os.environ["BELIEFATLAS_LIVE_PLACEMENT"],
                      credential=os.environ.get("BELIEFATLAS_LIVE_TEST_KEY"))
        body = cm.placement()
        self.assertTrue(body["questions"])
        card = body["questions"][0]
        self.assertEqual(set(card), set(CONTRACT["card"]))
        self.assertEqual(set(cm.split(card["id"])), set(CONTRACT["split"]))
        if os.environ.get("BELIEFATLAS_LIVE_TEST_KEY"):
            out = cm.relay_vote(user_id="live-unlinked", question_id=card["id"], value="true", idempotency_key="live-1")
            self.assertEqual(out["outcome"], "needs_link")


if __name__ == "__main__":
    unittest.main()

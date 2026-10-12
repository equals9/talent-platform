"""Portable denial/projection checks. No production rows or source services are written."""

import importlib.util
from contextlib import nullcontext
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

module_path = Path(__file__).resolve().parents[1] / "bridges/candidate_os_read.py"
spec = importlib.util.spec_from_file_location("candidate_read_bridge", module_path)
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


class ProjectionTests(unittest.TestCase):
    def test_source_configuration_supports_local_socket_without_executing_env_text(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / ".env").write_text("OTHER=$(never_execute)\nCANDIDATE_OS_DATABASE_URL=postgresql+psycopg:///existing_store\n")
            with patch.dict(os.environ, {}, clear=True):
                self.assertEqual(bridge.read_database_url(source), "postgresql+psycopg:///existing_store")
            for value in ("postgresql+psycopg://remote.example.org/store",
                          "postgresql+psycopg:///store?options=write_override", "sqlite:///store"):
                with patch.dict(os.environ, {"CANDIDATE_OS_DATABASE_URL": value}, clear=True):
                    with self.assertRaises(ValueError):
                        bridge.read_database_url(source)

    def test_only_allowed_professional_source_states(self):
        public = {"enabled": True, "requires_auth": False, "status": "active",
                  "source_type": "generic_web", "family": "provider_directory"}
        self.assertTrue(bridge.source_allowed(public))
        for change in ({"status": "blocked"}, {"requires_auth": True}, {"enabled": False},
                       {"family": "unknown"}, {"source_type": "local_export"}):
            self.assertFalse(bridge.source_allowed({**public, **change}))
        registry = {**public, "source_type": "registry", "adapter_name": "nppes", "key": "cms_nppes"}
        self.assertTrue(bridge.source_allowed(registry))
        self.assertFalse(bridge.source_allowed({**registry, "adapter_name": "nppes_endpoints"}))

    def test_private_restricted_or_off_source_evidence_urls_are_rejected(self):
        self.assertTrue(bridge.public_url("https://providers.example.org/person/alex", "example.org"))
        for url in ("http://127.0.0.1/a", "http://localhost/a", "http://10.0.0.1/a",
                    "https://linkedin.com/in/a", "https://a.doximity.com/a", "file:///x",
                    "https://u:p@example.org/a", "https://example.org:9443/a"):
            self.assertFalse(bridge.public_url(url))
        self.assertFalse(bridge.public_url("https://other.example.com/a", "example.org"))

    def test_retracted_facts_never_become_current_projection(self):
        rows = [{"predicate": "canonical_name", "value_json": {"value": "Alex Clinician"},
                 "is_current": True, "retracted": False, "observed_at": "2026-01-01",
                 "url": "https://example.org/alex"},
                {"predicate": "current_company", "value_json": "Old Employer", "is_current": True,
                 "retracted": True, "observed_at": "2026-10-01", "url": "https://example.org/alex"},
                {"predicate": "current_company", "value_json": "Current Employer", "is_current": True,
                 "retracted": False, "observed_at": "2026-09-01", "url": "https://example.org/alex"},
                {"predicate": "sex", "value_json": "private", "is_current": True,
                 "retracted": False, "observed_at": "2026-09-01", "url": "https://example.org/alex"},
                {"predicate": "npi", "value_json": "1234567890", "is_current": True,
                 "retracted": False, "observed_at": "2026-09-01", "url": "https://example.org/alex"}]
        person = bridge.project_person({"id": "upstream-id", "identity_status": "confirmed",
                                       "current_company": "Private projection"}, rows)
        self.assertEqual(person["company"], "Current Employer")
        self.assertEqual(person["npi"], "1234567890")
        self.assertNotIn("sex", person)
        self.assertNotIn("private", json.dumps(person))
        self.assertEqual(person["identityState"], "confirmed")
        self.assertIsNone(bridge.project_person({"id": "id"}, [{**rows[0], "retracted": True}]))

    def test_exact_quote_is_preserved_without_inventing_missing_record_quote(self):
        assertion = {"predicate": "current_title", "value_json": {"value": "Occupational Therapist"}}
        quote = "Alex Clinician — Occupational Therapist"
        evidence = {"evidence_type": "webpage", "metadata": {"extraction": [
            {"predicate": "current_title", "value": "Occupational Therapist", "passage": quote}]}}
        self.assertEqual(bridge.exact_quote(evidence, assertion), (quote, "verbatim_passage"))
        self.assertEqual(bridge.exact_quote({"evidence_type": "structured_record"}, assertion),
                         ("", "structured_assertion"))
        self.assertEqual(bridge.exact_quote(evidence, {**assertion, "value_json": "Not quoted"}),
                         ("", "unavailable"))

    def test_allowed_predicate_does_not_expose_nested_private_payload(self):
        self.assertIsNone(bridge.professional_value({"predicate": "current_company",
            "value_json": {"company": "Clinic", "sex": "private", "street": "private"}}))
        self.assertEqual(bridge.professional_value({"predicate": "reported_license", "value_json": {
            "number": "L1", "state": "CA", "status": "registry_reported_not_board_verified",
            "sex": "private", "street": "private"}}), {
            "number": "L1", "state": "CA", "status": "registry_reported_not_board_verified"})
        self.assertIsNone(bridge.professional_value({"predicate": "education", "value_json": [
            {"school": "University", "address": "private"}]}))

    def test_contact_inference_cannot_become_source_supported_action(self):
        # Exercise the actual contact projection against a read-only query facade.
        import sqlalchemy as sa
        metadata = sa.MetaData()
        contacts = sa.Table("contact_points", metadata,
            *[sa.Column(name, sa.String) for name in ("id", "person_id", "type", "classification",
                "evidence_id", "last_seen_at", "value", "status")])
        evidence = sa.Table("evidence", metadata, sa.Column("id", sa.String), sa.Column("metadata", sa.JSON))
        sample = {"id": "c1", "person_id": "p1", "type": "email", "classification": "professional",
                  "evidence_id": "e1", "last_seen_at": "2026-01-01", "value": "alex@example.org",
                  "status": "inferred"}
        class Connection:
            def execute(self, _):
                class Result:
                    def mappings(self):
                        return [sample]
                return Result()
            def scalar(self, _):
                return {"contact_passages": [{"type": "email", "passage": "Email alex@example.org"}]}
        reader = bridge.CandidateReader(None, {"contact_points": contacts, "evidence": evidence})
        group = {"e1": {"sourceType": "employer_site", "url": "https://example.org/alex"}}
        result = reader._contacts(Connection(), "p1", group)[0]
        self.assertFalse(result["evidenceSupported"])
        self.assertFalse(result["actionable"])
        self.assertEqual(result["review"], "pending")
        self.assertEqual(result["deliverability"], "unknown")
        group["e1"]["sourceType"] = "registry"
        self.assertEqual(reader._contacts(Connection(), "p1", group), [])

    def test_read_only_transaction_guard_fails_closed_and_always_rolls_back(self):
        class Transaction:
            rolled_back = False
            def rollback(self):
                self.rolled_back = True
        transaction = Transaction()
        class Connection:
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def begin(self): return transaction
            def scalar(self, _): return "off"
        class Engine:
            def connect(self): return Connection()
        reader = bridge.CandidateReader(Engine(), {})
        with self.assertRaisesRegex(RuntimeError, "not read-only"):
            with reader.connection():
                self.fail("Writable transaction must never be exposed")
        self.assertTrue(transaction.rolled_back)

    def test_exhausted_discovery_window_is_reported_even_without_public_matches(self):
        import sqlalchemy as sa
        metadata = sa.MetaData()
        persons = sa.Table("persons", metadata, *[sa.Column(name, sa.String) for name in (
            "id", "identity_status", "updated_at", "merged_into_person_id", "canonical_name")])
        documents = sa.Table("person_search_documents", metadata,
                             sa.Column("person_id", sa.String), sa.Column("search_text", sa.String))
        class Connection:
            def execute(self, _):
                class Result:
                    def mappings(self):
                        return [{"id": str(index)} for index in range(100)]
                return Result()
        reader = bridge.CandidateReader(None, {"persons": persons, "person_search_documents": documents})
        reader.connection = lambda: nullcontext(Connection())
        reader._rows = lambda *_: []
        result = reader.people("role", 25)
        self.assertEqual(result["people"], [])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["candidatesConsidered"], 100)

    def test_all_keywords_prefilter_and_current_public_projection_must_match(self):
        import sqlalchemy as sa
        from sqlalchemy.dialects import postgresql
        metadata = sa.MetaData()
        persons = sa.Table("persons", metadata, *[sa.Column(name, sa.String) for name in (
            "id", "identity_status", "updated_at", "merged_into_person_id", "canonical_name")])
        documents = sa.Table("person_search_documents", metadata,
                             sa.Column("person_id", sa.String), sa.Column("search_text", sa.String))
        class Connection:
            statement = None
            def execute(self, statement):
                self.statement = statement
                class Result:
                    def mappings(self):
                        return [{"id": "public"}, {"id": "mixed"}]
                return Result()
        connection = Connection()
        def fact(predicate, value, retracted=False):
            return {"predicate": predicate, "value_json": value, "is_current": True,
                    "retracted": retracted, "observed_at": "2026-09-01", "url": "https://example.org/person"}
        rows = {
            "public": [fact("canonical_name", "Dr Public"), fact("current_title", "Internal Medicine"),
                       fact("city", "Sacramento")],
            # The mixed source search document is only a prefilter. A private term cannot
            # qualify without a current allowed-public assertion; old retracted facts fail too.
            "mixed": [fact("canonical_name", "Dr Mixed"), fact("current_title", "Social Worker"),
                      fact("city", "Sacramento"), fact("primary_specialty", "Internal Medicine", True)],
        }
        reader = bridge.CandidateReader(None, {"persons": persons, "person_search_documents": documents})
        reader.connection = lambda: nullcontext(connection)
        reader._rows = lambda _, identifier: rows[identifier]
        result = reader.people("Sacramento Internal Medicine", 5)
        self.assertEqual([person["id"] for person in result["people"]], ["public"])
        compiled = connection.statement.compile(dialect=postgresql.dialect())
        patterns = [value for key, value in compiled.params.items() if key.startswith("search_text_")]
        self.assertEqual(patterns, ["%Sacramento%", "%Internal%", "%Medicine%"])
        self.assertEqual(str(compiled).count(" ILIKE "), 3)
        self.assertNotIn("%Sacramento Internal Medicine%", patterns)

    def test_keyword_sql_wildcards_remain_literal_and_terms_are_bounded(self):
        self.assertEqual(bridge.search_terms("A. Jo Chien"), ["A.", "Jo", "Chien"])
        self.assertEqual(bridge.search_terms("  Sacramento\tInternal\nMedicine "),
                         ["Sacramento", "Internal", "Medicine"])
        self.assertEqual(bridge.escape_like("a%_b\\c"), "a\\%\\_b\\\\c")
        with self.assertRaises(ValueError):
            bridge.search_terms(" ".join(["word"] * 13))


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Reader:
            calls = []
            def health(self): return {"ok": True, "readOnly": True}
            def people(self, q, limit):
                self.calls.append((q, limit))
                return {"people": [], "limit": limit}
            def person_evidence(self, identifier):
                raise KeyError(identifier)
        cls.reader = Reader()
        cls.token = "t" * 64
        cls.server = bridge.ReaderHTTPServer(("127.0.0.1", 0), cls.reader, cls.token)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(2)

    def request(self, path, method="GET", headers=None):
        request = Request(self.base + path, method=method,
                          headers={"Authorization": "Bearer " + self.token, **(headers or {})})
        try:
            with urlopen(request, timeout=2) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_authenticated_health_and_bounded_people(self):
        self.assertEqual(self.request("/health"), (200, {"ok": True, "readOnly": True}))
        self.assertEqual(self.request("/people?q=Alex&limit=2")[0], 200)
        self.assertEqual(self.reader.calls[-1], ("Alex", 2))

    def test_authentication_host_and_origin_denials(self):
        self.assertEqual(self.request("/health", headers={"Authorization": ""})[0], 401)
        self.assertEqual(self.request("/health", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request("/health", headers={"Origin": "http://127.0.0.1:4320"})[0], 403)

    def test_only_allowlisted_get_routes_and_valid_queries(self):
        for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS"):
            self.assertEqual(self.request("/people", method)[0], 405)
        for path in ("/people?q=x", "/people?q=Alex&limit=26", "/people?q=Alex&limit=0",
                     "/people?q=Alex&limit=invalid", "/people?q=Alex&q=Other", "/people?q=Alex&write=true",
                     "/people?q=" + "+".join(["word"] * 13)):
            self.assertEqual(self.request(path)[0], 400)
        self.assertEqual(self.request("/jobs")[0], 404)
        self.assertEqual(self.request("/people/00000000-0000-0000-0000-000000000000/evidence")[0], 404)


if __name__ == "__main__":
    unittest.main()

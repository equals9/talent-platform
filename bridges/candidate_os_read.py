#!/usr/bin/env python3
"""Loopback, read-only projection of an explicitly configured Candidate OS store.

This reader never imports source acquisition/services, reads raw evidence files, or
creates source tables. Source SQLAlchemy tables are loaded from the existing owner.
"""

from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
from uuid import UUID

BRIDGE_VERSION = "0.1.0"
MAX_EVIDENCE = 100
MAX_ASSERTIONS = 500
PROFESSIONAL_PREDICATES = frozenset({
    "canonical_name", "credentials_display", "current_title", "current_company",
    "city", "state", "country", "primary_profession", "primary_specialty", "skill",
    "education", "credential", "years_experience", "npi", "taxonomy",
    "reported_license", "license_state", "orcid", "github", "portfolio_url", "department",
})
SOURCE_TYPES = frozenset({"employer_site", "university", "state_board", "publication",
                          "conference", "repository", "portfolio", "personal_site"})
SOURCE_FAMILIES = frozenset({"provider_directory", "faculty_directory", "publication_profile",
                             "profile_repository", "portfolio", "professional_directory"})
RESTRICTED_HOSTS = ("linkedin.com", "doximity.com")


def iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def search_terms(q: str) -> list[str]:
    terms = q.split()
    if not 2 <= len(q.strip()) <= 160 or not 1 <= len(terms) <= 12:
        raise ValueError("Search requires 2-160 characters and at most 12 keywords")
    return terms


def escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def public_url(value: str, source_domain: str = "") -> bool:
    """Evidence links must be public professional URLs and bound to their source."""
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme not in {"https", "http"} or not host or parsed.username or parsed.password:
            return False
        if parsed.port not in {None, 80, 443} or host == "localhost" or "." not in host:
            return False
        if any(host == h or host.endswith("." + h) for h in RESTRICTED_HOSTS):
            return False
        try:
            if not ipaddress.ip_address(host).is_global:
                return False
        except ValueError:
            if host.endswith((".local", ".internal", ".localhost")):
                return False
        if source_domain:
            domain = source_domain.lower().rstrip(".")
            if not (host == domain or host.endswith("." + domain)):
                return False
        return True
    except (ValueError, TypeError):
        return False


def source_allowed(source: dict) -> bool:
    if not source.get("enabled") or source.get("requires_auth"):
        return False
    if source.get("status") not in {"approved", "active"}:
        return False
    if source.get("source_type") == "registry":
        return source.get("adapter_name") == "nppes" and source.get("key") == "cms_nppes"
    return source.get("source_type") in SOURCE_TYPES or (
        source.get("source_type") == "generic_web" and source.get("family") in SOURCE_FAMILIES
    )


def asserted_value(assertion: dict):
    value = assertion.get("value_json")
    # Existing source versions represent scalar assertions either directly or as {value: ...}.
    if isinstance(value, dict) and set(value) == {"value"}:
        return value["value"]
    return value


def professional_value(assertion: dict):
    """Nested source payloads cannot smuggle unrelated fields through a allowed predicate."""
    value = asserted_value(assertion)
    if isinstance(value, dict):
        if assertion.get("predicate") != "reported_license":
            return None
        value = {key: item for key, item in value.items()
                 if key in {"number", "state", "taxonomy", "status"}
                 and isinstance(item, (str, int, float)) and not isinstance(item, bool)}
        return value or None
    if isinstance(value, list):
        if len(value) > 50 or any(not isinstance(item, (str, int, float)) or isinstance(item, bool)
                                 for item in value):
            return None
        return value
    if isinstance(value, (str, int, float)) and not isinstance(value, bool):
        return value
    return None


def exact_quote(evidence: dict, assertion: dict) -> tuple[str, str]:
    metadata = evidence.get("metadata") or {}
    value = asserted_value(assertion)
    for item in metadata.get("extraction", []):
        if item.get("predicate") == assertion.get("predicate") and str(item.get("value")) == str(value):
            return str(item.get("passage") or ""), "verbatim_passage"
    identifier = metadata.get("identifier_passages", {}).get(assertion.get("predicate"), {})
    if identifier.get("passage"):
        return str(identifier["passage"]), "verbatim_passage"
    # Structured record assertions are not verbatim quotations. Keep that gap explicit.
    return "", "structured_assertion" if evidence.get("evidence_type") == "structured_record" else "unavailable"


def project_person(person: dict, rows: list[dict]) -> dict | None:
    current = [r for r in rows if r.get("is_current") and not r.get("retracted")
               and r.get("predicate") in PROFESSIONAL_PREDICATES]
    current.sort(key=lambda r: str(iso(r.get("observed_at")) or ""), reverse=True)
    values = {}
    for row in current:
        value = professional_value(row)
        if value is not None:
            values.setdefault(row["predicate"], value)
    if not values.get("canonical_name"):
        return None
    return {
        "id": str(person["id"]), "name": str(values["canonical_name"]),
        "company": str(values.get("current_company") or ""),
        "title": str(values.get("current_title") or values.get("primary_profession") or ""),
        "location": ", ".join(str(values[k]) for k in ("city", "state", "country") if values.get(k)),
        "identityState": person.get("identity_status", "provisional"),
        "profileUrls": sorted({r["url"] for r in current if public_url(r.get("url", ""))}),
        "observedAt": iso(current[0].get("observed_at")) if current else None,
        "upstreamUpdatedAt": iso(person.get("updated_at")),
        "sourceSystem": "candidate_intelligence_os",
        "npi": str(values.get("npi") or "") if re.fullmatch(r"[12][0-9]{9}", str(values.get("npi") or "")) else "",
    }


class CandidateReader:
    def __init__(self, engine, tables, source_version="unknown"):
        self.engine, self.tables, self.source_version = engine, tables, source_version
        import sqlalchemy as sa
        self.sa = sa

    @contextmanager
    def connection(self):
        # libpq default is set on every new connection; verify the active transaction too.
        with self.engine.connect() as connection:
            transaction = connection.begin()
            try:
                if connection.scalar(self.sa.text("SHOW transaction_read_only")) != "on":
                    raise RuntimeError("Source transaction is not read-only")
                connection.execute(self.sa.text("SET LOCAL statement_timeout = '10000ms'"))
                yield connection
            finally:
                transaction.rollback()

    def health(self):
        with self.connection() as c:
            migration = c.scalar(self.sa.text("SELECT version_num FROM alembic_version"))
        return {"ok": True, "readOnly": True, "sourceSystem": "candidate_intelligence_os",
                "sourceVersion": self.source_version, "schemaVersion": migration,
                "bridgeVersion": BRIDGE_VERSION, "policy": "public_professional_sources_only"}

    def _safe_source(self):
        sa, t = self.sa, self.tables["sources"]
        return sa.and_(t.c.enabled.is_(True), t.c.requires_auth.is_(False),
            t.c.status.in_(["active", "approved"]), sa.or_(
                sa.and_(t.c.source_type == "registry", t.c.adapter_name == "nppes", t.c.key == "cms_nppes"),
                t.c.source_type.in_(sorted(SOURCE_TYPES)),
                sa.and_(t.c.source_type == "generic_web", t.c.family.in_(sorted(SOURCE_FAMILIES)))))

    def _rows(self, c, person_id):
        sa, t = self.sa, self.tables
        a, e, s, r = (t[n] for n in ("assertions", "evidence", "sources", "assertion_retractions"))
        # Never select raw_text/raw_json/local_path, demographic predicates, or personal contacts.
        stmt = sa.select(a, e.c.url, e.c.retrieved_at, e.c.content_hash, e.c.evidence_type,
            e.c.metadata.label("evidence_metadata"), e.c.external_id, s.c.id.label("source_id"),
            s.c.key.label("source_key"), s.c.name.label("source_name"), s.c.domain,
            s.c.source_type, s.c.adapter_name, s.c.status.label("source_status"), s.c.family,
            s.c.enabled, s.c.requires_auth, r.c.id.label("retraction_id"))\
            .select_from(a.join(e, e.c.id == a.c.evidence_id).join(s, s.c.id == e.c.source_id)
                         .outerjoin(r, r.c.assertion_id == a.c.id))\
            .where(a.c.subject_id == person_id, a.c.subject_type == "person",
                   a.c.predicate.in_(sorted(PROFESSIONAL_PREDICATES)), self._safe_source())\
            .order_by(a.c.observed_at.desc(), a.c.id).limit(MAX_ASSERTIONS + 1)
        out = []
        for item in c.execute(stmt).mappings():
            row = dict(item)
            if not public_url(row["url"], row["domain"]) or professional_value(row) is None:
                continue
            row["retracted"] = bool(row["retraction_id"])
            out.append(row)
        return out

    def people(self, q, limit=25):
        sa, t = self.sa, self.tables
        p, d = t["persons"], t["person_search_documents"]
        terms = search_terms(q)
        with self.connection() as c:
            # The existing trigram search index bounds discovery; output is then reconstructed
            # solely from allowed current assertions, never from mixed-source projections.
            stmt = sa.select(p.c.id, p.c.identity_status, p.c.updated_at).join(d, d.c.person_id == p.c.id)\
                .where(p.c.merged_into_person_id.is_(None),
                       *[d.c.search_text.ilike(f"%{escape_like(term)}%", escape="\\") for term in terms])\
                .order_by(p.c.canonical_name, p.c.id).limit(100)
            people = []
            considered = 0
            for row in c.execute(stmt).mappings():
                considered += 1
                person = project_person(dict(row), self._rows(c, row["id"]))
                public_text = " ".join(person.get(k, "") for k in ("name", "company", "title", "location")).casefold() if person else ""
                if person and all(term.casefold() in public_text for term in terms):
                    people.append(person)
                if len(people) >= limit:
                    break
        return {"people": people, "limit": limit, "searchScope": "public_professional_projection",
                "searchSemantics": "all_literal_keywords", "keywords": terms,
                "candidateWindow": 100, "candidatesConsidered": considered,
                "truncated": len(people) >= limit or considered >= 100}

    def person_evidence(self, person_id):
        sa, t = self.sa, self.tables
        p = t["persons"]
        with self.connection() as c:
            original = c.execute(sa.select(p.c.id, p.c.identity_status, p.c.updated_at,
                p.c.merged_into_person_id).where(p.c.id == person_id)).mappings().first()
            if not original or original["merged_into_person_id"]:
                raise KeyError("Person unavailable")
            rows = self._rows(c, person_id)
            person = project_person(dict(original), rows)
            if person is None:
                raise KeyError("Person has no allowed current professional evidence")
            groups = {}
            for row in rows[:MAX_ASSERTIONS]:
                eid = str(row["evidence_id"])
                if eid not in groups and len(groups) >= MAX_EVIDENCE:
                    continue
                evidence = groups.setdefault(eid, {
                    "id": eid, "url": row["url"], "observedAt": iso(row["retrieved_at"]),
                    "contentHash": row["content_hash"], "externalId": row["external_id"],
                    "sourceId": str(row["source_id"]), "sourceKey": row["source_key"],
                    "sourceName": row["source_name"], "sourceType": row["source_type"],
                    "status": "observed", "assertions": [],
                })
                quote, quote_kind = exact_quote({"metadata": row["evidence_metadata"],
                    "evidence_type": row["evidence_type"]}, row)
                evidence["assertions"].append({"id": str(row["id"]), "predicate": row["predicate"],
                    "value": professional_value(row), "quote": quote, "quoteKind": quote_kind,
                    "observedAt": iso(row["observed_at"]), "retracted": row["retracted"],
                    "current": bool(row["is_current"]),
                    "status": "retracted" if row["retracted"] else "current" if row["is_current"] else "historical"})
            contacts = self._contacts(c, person_id, groups)
        return {"person": person, "evidence": list(groups.values()), "contacts": contacts,
                "limits": {"evidence": MAX_EVIDENCE, "assertions": MAX_ASSERTIONS},
                "truncated": len(rows) > MAX_ASSERTIONS or len(groups) >= MAX_EVIDENCE,
                "warnings": ["Registry facts are reported observations, not board verification or current employment proof.",
                             "Contact deliverability is unknown. Association requires human review."]}

    def _contacts(self, c, person_id, groups):
        sa, t = self.sa, self.tables["contact_points"]
        stmt = sa.select(t).where(t.c.person_id == person_id, t.c.type == "email",
            t.c.classification.in_(["professional", "organizational"])).order_by(t.c.last_seen_at.desc()).limit(50)
        out = []
        for item in c.execute(stmt).mappings():
            row, evidence = dict(item), groups.get(str(item["evidence_id"]))
            if not evidence or evidence["sourceType"] == "registry":
                continue
            # Recover only the selected evidence's contact passages; no raw document reads.
            e = self.tables["evidence"]
            metadata = c.scalar(sa.select(e.c.metadata).where(e.c.id == row["evidence_id"])) or {}
            quote = next((str(p.get("passage") or "") for p in metadata.get("contact_passages", [])
                          if p.get("type") == "email" and row["value"].casefold() in str(p.get("passage") or "").casefold()), "")
            inferred = row["status"] == "inferred"
            out.append({"id": str(row["id"]), "value": row["value"], "type": "email",
                "status": row["status"], "classification": row["classification"],
                "evidenceId": str(row["evidence_id"]), "sourceUrl": evidence["url"],
                "quote": quote, "observedAt": iso(row["last_seen_at"]),
                "deliverability": "unknown", "review": "pending", "actionable": False,
                "evidenceSupported": bool(quote) and not inferred and row["status"] in {"observed", "verified"}})
        return out


class ReaderHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    def __init__(self, address, reader, token):
        self.reader, self.token = reader, token
        super().__init__(address, ReaderHandler)


class ReaderHandler(BaseHTTPRequestHandler):
    server_version = "TalentEvidenceReader"
    def log_message(self, *_):
        pass  # Requests contain candidate queries; do not log them or credentials.

    def respond(self, status, value):
        body = json.dumps(value, ensure_ascii=False, default=iso).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if len(self.path) > 4096:
            return self.respond(400, {"error": "Read request is too long"})
        if self.headers.get("Origin") or self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            return self.respond(403, {"error": "Loopback server clients only"})
        expected = "Bearer " + self.server.token
        if not hmac.compare_digest(self.headers.get("Authorization", "").encode(), expected.encode()):
            return self.respond(401, {"error": "Reader authentication required"})
        try:
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
            if any(len(v) != 1 for v in query.values()):
                raise ValueError("Duplicate query parameters")
            if parsed.path == "/health" and not query:
                return self.respond(200, self.server.reader.health())
            if parsed.path == "/people":
                if set(query) - {"q", "limit"}:
                    raise ValueError("Unknown query parameter")
                q = query.get("q", [""])[0].strip()
                limit = int(query.get("limit", ["25"])[0])
                if not 2 <= len(q) <= 160 or not 1 <= limit <= 25:
                    raise ValueError("Search requires 2-160 characters and limit 1-25")
                search_terms(q)
                return self.respond(200, self.server.reader.people(q, limit))
            match = re.fullmatch(r"/people/([0-9a-fA-F-]{36})/evidence", parsed.path)
            if match and not query:
                identifier = str(UUID(match[1]))
                return self.respond(200, self.server.reader.person_evidence(identifier))
            return self.respond(404, {"error": "Read route not found"})
        except (ValueError, TypeError):
            return self.respond(400, {"error": "Invalid read request"})
        except KeyError:
            return self.respond(404, {"error": "Person unavailable in public professional scope"})
        except Exception:
            # Database exception strings can contain connection secrets and source data.
            return self.respond(503, {"error": "Evidence reader unavailable; inspect local configuration"})

    def do_POST(self):
        self.respond(405, {"error": "Reader accepts GET only"})
    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_HEAD = do_POST


def read_database_url(source):
    value = os.environ.get("CANDIDATE_OS_DATABASE_URL", "")
    if not value:
        for line in (source / ".env").read_text().splitlines():
            match = re.fullmatch(r"\s*(?:export\s+)?CANDIDATE_OS_DATABASE_URL\s*=\s*(.*?)\s*", line)
            if match:
                value = match[1].strip("\"'")
                break
    parsed = urlsplit(value)
    if not parsed.scheme.startswith("postgresql") or parsed.hostname not in {None, "127.0.0.1", "localhost", "::1"}:
        raise ValueError("An existing local PostgreSQL source URL is required")
    if parsed.query:
        raise ValueError("Source URL connection query overrides are not supported")
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=4322)
    args = parser.parse_args()
    try:
        source = Path(os.environ["CANDIDATE_OS_SOURCE_PATH"]).resolve(strict=True)
        token = os.environ.get("TALENT_EVIDENCE_TOKEN", "")
        if not token and os.environ.get("TALENT_EVIDENCE_TOKEN_FILE"):
            token = Path(os.environ["TALENT_EVIDENCE_TOKEN_FILE"]).read_text().strip()
        if len(token) < 32:
            raise ValueError("A private reader token of at least 32 characters is required")
        if not (source / "candidate_os/db/schema.py").is_file():
            raise ValueError("Configured source schema is missing")
        url = read_database_url(source)
        sys.path.insert(0, str(source))
        import sqlalchemy as sa
        from candidate_os.db.schema import TABLES
        connection_args = {"connect_timeout": 5,
            "options": "-c default_transaction_read_only=on -c statement_timeout=10000"}
        if not urlsplit(url).hostname:
            # Empty source hosts mean Unix sockets. Pin the local socket directory so
            # ambient PGHOST cannot redirect an authorized local read to a remote host.
            socket_dir = os.environ.get("CANDIDATE_OS_SOCKET_DIR", "/tmp")
            if not Path(socket_dir).is_absolute() or not Path(socket_dir).is_dir():
                raise ValueError("An absolute local PostgreSQL socket directory is required")
            connection_args["host"] = socket_dir
        engine = sa.create_engine(url, pool_pre_ping=True, pool_size=2, max_overflow=0,
            connect_args=connection_args)
        version = subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
            capture_output=True, text=True, check=True).stdout.strip()
        reader = CandidateReader(engine, TABLES, version)
        reader.health()
        server = ReaderHTTPServer(("127.0.0.1", args.port), reader, token)
        print(f"Read-only Candidate Intelligence evidence reader listening on 127.0.0.1:{args.port}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except Exception:
        print("Reader startup failed. Check the configured source, private token and local PostgreSQL access.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

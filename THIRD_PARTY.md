# Source and licensing boundaries

The new platform implementation and the first-party Lead Finder source carried into `apps/contact-finder` are provided under this repository's MIT license. The retained source-copy manifest identifies the original local files and hashes before platform changes.

No PRISM, Odoo, Frappe, Twenty, Horilla, OpenCATS, OpenResume, Cal.diy or pgvector implementation is vendored into the runtime. Their repository code was inspected for research only. `research/upstream/` contains ignored, locally retained audit copies with their own upstream copyrights and licenses; it is not part of the open-source application package.

VitalCV is proprietary in its current source documentation. This workspace references its existing local checkout and contracts; this repository's license does not relicense VitalCV, TalentOS, Candidate Intelligence OS, their dependencies, or third-party services. Future code migration requires an explicit source/license decision. Integration endpoints and export adapters do not imply permission to publish private records or upstream source.

The core runtime and TalentOS/VitalCV gateway use only Node.js built-in modules. The optional first-party Candidate Intelligence bridge references an operator-owned existing source checkout, schema and Python environment with SQLAlchemy and its PostgreSQL driver; it does not redistribute that source. Synthetic reader tests pin SQLAlchemy in their test requirements. No npm packages or models are downloaded by application setup. Research reports document license constraints for selected potential components; they are not legal clearance or evidence those components have been integrated.

Keep candidate databases, evidence blobs, documents, credentials, local exports, and private verification screenshots out of Git. Use only synthetic records in public examples and tests.

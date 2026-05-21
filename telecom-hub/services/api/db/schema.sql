-- Telecom Research Hub — Postgres schema

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Meetings ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS meetings (
  id               TEXT PRIMARY KEY,              -- e.g. "RAN1#116"
  working_group    TEXT        NOT NULL,
  meeting_number   TEXT        NOT NULL,
  start_date       DATE,
  end_date         DATE,
  location         TEXT,
  ftp_path         TEXT        NOT NULL,
  tdoc_count       INTEGER     DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meetings_wg_idx ON meetings (working_group);

-- ── TDocs ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tdocs (
  id               TEXT PRIMARY KEY,              -- e.g. "R1-2401234"
  meeting_id       TEXT        NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  working_group    TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  source           TEXT        NOT NULL,
  type             TEXT        NOT NULL DEFAULT 'TD',
  status           TEXT        NOT NULL DEFAULT 'unknown',
  agenda           TEXT,
  related_spec     TEXT,
  related_cr       TEXT,
  revision_of      TEXT,
  revised_to       TEXT,
  abstract         TEXT,
  ftp_url          TEXT,
  indexed_at       TIMESTAMPTZ DEFAULT NOW(),
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS tdocs_meeting_idx      ON tdocs (meeting_id);
CREATE INDEX IF NOT EXISTS tdocs_wg_idx           ON tdocs (working_group);
CREATE INDEX IF NOT EXISTS tdocs_status_idx       ON tdocs (status);
CREATE INDEX IF NOT EXISTS tdocs_source_idx       ON tdocs (source);
CREATE INDEX IF NOT EXISTS tdocs_related_spec_idx ON tdocs (related_spec);

-- ── Patents ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patents (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  publication_number  TEXT        UNIQUE NOT NULL,
  title               TEXT        NOT NULL,
  abstract            TEXT,
  applicant           TEXT        NOT NULL,
  inventors           TEXT[]      DEFAULT '{}',
  filing_date         DATE,
  publication_date    DATE,
  grant_date          DATE,
  status              TEXT        NOT NULL DEFAULT 'pending',
  classifications     TEXT[]      DEFAULT '{}',
  jurisdiction        TEXT        NOT NULL DEFAULT 'US',
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS patents_applicant_idx ON patents (applicant);
CREATE INDEX IF NOT EXISTS patents_status_idx    ON patents (status);

-- ── Patent ↔ TDoc links ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patent_tdoc_links (
  patent_id  TEXT NOT NULL REFERENCES patents(id) ON DELETE CASCADE,
  tdoc_id    TEXT NOT NULL REFERENCES tdocs(id)   ON DELETE CASCADE,
  PRIMARY KEY (patent_id, tdoc_id)
);

-- ── Patent ↔ Spec links ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patent_spec_links (
  patent_id   TEXT NOT NULL REFERENCES patents(id) ON DELETE CASCADE,
  spec_number TEXT NOT NULL,
  PRIMARY KEY (patent_id, spec_number)
);

-- ── Patent Folios ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS patent_folios (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name        TEXT        NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS folio_patents (
  folio_id   TEXT NOT NULL REFERENCES patent_folios(id) ON DELETE CASCADE,
  patent_id  TEXT NOT NULL REFERENCES patents(id)       ON DELETE CASCADE,
  PRIMARY KEY (folio_id, patent_id)
);

-- ── Full-text search index ───────────────────────────────────────────────────
-- Stores only the tsvector (not the raw text) so body text is never persisted.

CREATE TABLE IF NOT EXISTS tdoc_fulltext (
  tdoc_id  TEXT PRIMARY KEY,
  body_tsv TSVECTOR NOT NULL
);

CREATE INDEX IF NOT EXISTS tdoc_fulltext_tsv_idx ON tdoc_fulltext USING GIN (body_tsv);

-- ── Crawl state ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crawl_runs (
  id             BIGSERIAL PRIMARY KEY,
  working_group  TEXT        NOT NULL,
  started_at     TIMESTAMPTZ DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  meetings_found INTEGER     DEFAULT 0,
  tdocs_indexed  INTEGER     DEFAULT 0,
  status         TEXT        NOT NULL DEFAULT 'running'  -- running | done | failed
);

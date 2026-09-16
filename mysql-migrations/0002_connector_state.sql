CREATE TABLE connector_identity (
  id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

CREATE TABLE connector_config (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connector_key VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  brand_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  brand_name TEXT NOT NULL,
  brand_subdomain VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  selected_locales_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  destination_name TEXT NOT NULL,
  preview_url TEXT,
  execution_target VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  credential_envelope_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (connector_id),
  CONSTRAINT connector_config_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE scheduler_state (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  next_due_at DATETIME(6),
  retry_attempt TINYINT UNSIGNED NOT NULL,
  pause_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY (connector_id),
  CONSTRAINT scheduler_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE pending_probes (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  probe_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (connector_id),
  CONSTRAINT probes_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE manifest_meta (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  PRIMARY KEY (connector_id),
  CONSTRAINT manifest_meta_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE runs (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  workflow_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  started_at DATETIME(6) NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  finished_at DATETIME(6),
  source_count INT UNSIGNED NOT NULL DEFAULT 0,
  new_count INT UNSIGNED NOT NULL DEFAULT 0,
  changed_count INT UNSIGNED NOT NULL DEFAULT 0,
  unchanged_count INT UNSIGNED NOT NULL DEFAULT 0,
  stale_count INT UNSIGNED NOT NULL DEFAULT 0,
  planned_deletion_count INT UNSIGNED NOT NULL DEFAULT 0,
  successful_deletion_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_deletion_count INT UNSIGNED NOT NULL DEFAULT 0,
  withheld_deletion_count INT UNSIGNED NOT NULL DEFAULT 0,
  warning_count INT UNSIGNED NOT NULL DEFAULT 0,
  quarantine_count INT UNSIGNED NOT NULL DEFAULT 0,
  failure_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  PRIMARY KEY (connector_id, id),
  UNIQUE KEY runs_workflow_uq (connector_id, workflow_id),
  KEY runs_started_at (connector_id, started_at, id),
  KEY runs_state (connector_id, state, updated_at),
  CONSTRAINT runs_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE active_run (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  PRIMARY KEY (connector_id),
  UNIQUE KEY active_run_uq (connector_id, run_id),
  CONSTRAINT active_run_run_fk FOREIGN KEY (connector_id, run_id) REFERENCES runs(connector_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE staged_records (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  destination_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_subdomain VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  article_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  translation_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  locale VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_updated_at DATETIME(6) NOT NULL,
  content_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  document_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  warning_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  PRIMARY KEY (connector_id, run_id, destination_id),
  KEY staged_locale (connector_id, run_id, locale, destination_id(128)),
  CONSTRAINT staged_run_fk FOREIGN KEY (connector_id, run_id) REFERENCES runs(connector_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE manifest (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  destination_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_subdomain VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  article_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  translation_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  locale VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  source_updated_at DATETIME(6) NOT NULL,
  content_hash VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_seen_run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  acknowledged_at DATETIME(6) NOT NULL,
  PRIMARY KEY (connector_id, destination_id),
  UNIQUE KEY manifest_source_uq (connector_id, source_subdomain, article_id, locale),
  KEY manifest_locale (connector_id, locale, destination_id(128)),
  KEY manifest_last_seen (connector_id, last_seen_run_id, destination_id(128)),
  CONSTRAINT manifest_run_fk FOREIGN KEY (connector_id, last_seen_run_id) REFERENCES runs(connector_id, id)
) ENGINE=InnoDB;

CREATE TABLE deletion_plans (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  exact_ids_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  stale_count INT UNSIGNED NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  manifest_revision INT UNSIGNED NOT NULL,
  source_fingerprint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  manifest_fingerprint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  destination_fingerprint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  confirmed_at DATETIME(6),
  PRIMARY KEY (connector_id, id),
  UNIQUE KEY deletion_run_uq (connector_id, run_id),
  UNIQUE KEY deletion_fingerprint_uq (connector_id, fingerprint),
  KEY deletion_state (connector_id, state, created_at),
  CONSTRAINT deletion_run_fk FOREIGN KEY (connector_id, run_id) REFERENCES runs(connector_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE locale_change_plans (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  config_revision INT UNSIGNED NOT NULL,
  selected_locales_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  removed_record_count INT UNSIGNED NOT NULL,
  fingerprint VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (connector_id, id),
  UNIQUE KEY locale_plan_fingerprint_uq (connector_id, fingerprint),
  KEY locale_plan_state (connector_id, state, created_at),
  CONSTRAINT locale_plan_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE issues (
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  article_id VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  locale VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  public_title TEXT NOT NULL,
  public_url TEXT NOT NULL,
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  first_seen_run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  last_seen_run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  first_seen_at DATETIME(6) NOT NULL,
  last_seen_at DATETIME(6) NOT NULL,
  resolved_at DATETIME(6),
  stable_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin,
  PRIMARY KEY (connector_id, id),
  UNIQUE KEY issues_identity_uq (connector_id, article_id, locale, reason_code),
  KEY issues_state_seen (connector_id, state, last_seen_at),
  CONSTRAINT issues_connector_fk FOREIGN KEY (connector_id) REFERENCES connector_identity(id)
) ENGINE=InnoDB;

CREATE TABLE telemetry (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  connector_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  run_id VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  phase VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  visibility VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt TINYINT UNSIGNED,
  batch_number INT UNSIGNED,
  record_count INT UNSIGNED,
  duration_ms INT UNSIGNED,
  created_at DATETIME(6) NOT NULL,
  PRIMARY KEY (id),
  KEY telemetry_run_created (connector_id, run_id, created_at, id),
  CONSTRAINT telemetry_run_fk FOREIGN KEY (connector_id, run_id) REFERENCES runs(connector_id, id) ON DELETE CASCADE
) ENGINE=InnoDB;

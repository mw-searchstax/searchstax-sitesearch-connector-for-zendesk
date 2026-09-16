-- Schema 3 is the explicit compatibility gate for OAuth credential envelopes.
-- The envelope remains opaque to persistence. This singleton records that the
-- database has crossed the gate while allowing legacy envelopes to be read.
CREATE TABLE oauth_compatibility (
  singleton TINYINT UNSIGNED NOT NULL,
  envelope_format VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (singleton),
  CONSTRAINT oauth_compatibility_singleton_ck CHECK (singleton = 1)
) ENGINE=InnoDB;

INSERT INTO oauth_compatibility(singleton, envelope_format)
VALUES (1, 'legacy-or-oauth');

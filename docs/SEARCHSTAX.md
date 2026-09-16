# SearchStax contract

The connector writes only records in its own connector namespace. It does not
create or change the destination schema. Before setup, confirm that the
selected app accepts the following fields with the expected scalar, boolean,
date, and multi-valued shapes:

| Field                                                 | Expected shape      |
| ----------------------------------------------------- | ------------------- |
| `id`                                                  | unique string       |
| `connector_key_s`, `source_system_s`, `source_type_s` | string              |
| `source_brand_id_s`, `source_brand_s`                 | string              |
| `zendesk_article_id_s`, `zendesk_translation_id_s`    | string              |
| `locale_s`, `url_s`, `section_id_s`, `section_name_s` | string              |
| `category_id_s`, `category_name_s`, `visibility_s`    | string              |
| `title_txt_{language}`, `body_text_txt_{language}`    | searchable text     |
| `created_at_dt`, `updated_at_dt`                      | date                |
| `label_names_ss`                                      | multi-valued string |
| `promoted_b`, `outdated_b`                            | boolean             |

For each selected locale, both dynamic text fields must use the exact approved
language suffix. Unsupported locales remain disabled; the connector does not
substitute a generic analyzer.

The update endpoint must use HTTPS and end in `/update` or `/update/json/docs`;
the select endpoint must use HTTPS and end in `/select`. Use a dedicated app or
prove connector-key isolation from other sources. A readiness check writes one
probe, reads it by exact ID, deletes it, and confirms disappearance. Treat
uncertain cleanup as a stop condition.

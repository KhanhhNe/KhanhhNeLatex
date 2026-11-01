ALTER TABLE `documents` ADD `code` text;--> statement-breakpoint
-- Codes identify private documents, not access tokens. Numbering guarantees a
-- collision-free backfill; new documents use random 48-bit URL-safe codes.
WITH numbered AS (
  SELECT id, printf('%08x', row_number() OVER (ORDER BY id)) AS code FROM documents
)
UPDATE documents SET code = (SELECT code FROM numbered WHERE numbered.id = documents.id);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_code_unique` ON `documents` (`code`);
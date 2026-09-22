CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "Promotion"
ADD CONSTRAINT "no_overlapping_product_promotions"
EXCLUDE USING gist (
  "productId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
)
WHERE (
  "productId" IS NOT NULL
  AND "cancelledAt" IS NULL
);

ALTER TABLE "Promotion"
ADD CONSTRAINT "no_overlapping_category_promotions"
EXCLUDE USING gist (
  "categoryId" WITH =,
  tstzrange("startAt", "endAt", '[)') WITH &&
)
WHERE (
  "categoryId" IS NOT NULL
  AND "cancelledAt" IS NULL
);

-- Product monetary and stock invariants
ALTER TABLE "Product"
ADD CONSTRAINT "product_base_price_non_negative"
CHECK ("basePrice" >= 0);

ALTER TABLE "Product"
ADD CONSTRAINT "product_stock_quantity_non_negative"
CHECK ("stockQuantity" >= 0);

-- Promotion date, value, and exclusive-target invariants
ALTER TABLE "Promotion"
ADD CONSTRAINT "promotion_valid_dates"
CHECK ("startAt" < "endAt");

ALTER TABLE "Promotion"
ADD CONSTRAINT "promotion_valid_value"
CHECK (
  ("discountType" = 'PERCENTAGE' AND "value" > 0 AND "value" <= 100)
  OR
  ("discountType" = 'FIXED' AND "value" > 0)
);

ALTER TABLE "Promotion"
ADD CONSTRAINT "promotion_single_target"
CHECK (num_nonnulls("productId", "categoryId") <= 1);

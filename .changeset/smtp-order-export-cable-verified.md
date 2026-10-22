---
"saleor-app-smtp": patch
---

The order export has a "Câble vérifié" column for cable lines.
- `oui`: the line's metadata matches the record the checkout-prices app wrote when it priced the cable.
- `modifié`: the metadata was changed afterwards.
- `non`: no record. With the optional `CABLE_VERIFICATION_CUTOFF` set, orders created before that date show `non (avant vérification)`.
A line counts as a cable line when its product is the cable product (`CABLE_PRODUCT_SLUG`, default `cable-custom`) or it has a record.

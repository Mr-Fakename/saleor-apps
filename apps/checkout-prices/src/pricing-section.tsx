import { Box, Button, Input, Text } from "@saleor/macaw-ui/next";
import React, { useState, useCallback, useMemo } from "react";
import {
  VariantDetailsFragment,
  useSearchVariantsQuery,
  useSetQuantityPricingMutation,
} from "../generated/graphql";
import { DEFAULT_CHANNEL } from "./const";
import { formatPrice } from "./lib/format-price";
import { useTranslations, type TranslationKeys } from "./lib/i18n";

const ITEMS_PER_PAGE = 20;

interface PricingTier {
  quantity: string;
  price: string;
}

export const PricingSection = () => {
  const t = useTranslations();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);

  // Debounce search input
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setCursor(null);
    const timeoutId = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, []);

  const [{ data, fetching }] = useSearchVariantsQuery({
    variables: {
      channel: DEFAULT_CHANNEL,
      search: debouncedSearch || null,
      first: ITEMS_PER_PAGE,
      after: cursor,
    },
  });

  const variants = data?.productVariants?.edges.map((edge) => edge.node) || [];
  const pageInfo = data?.productVariants?.pageInfo;
  const totalCount = data?.productVariants?.totalCount || 0;

  const handleNextPage = () => {
    if (pageInfo?.hasNextPage && pageInfo.endCursor) {
      setCursor(pageInfo.endCursor);
    }
  };

  const handlePrevPage = () => {
    setCursor(null); // Reset to first page for simplicity
  };

  const getFoundText = () => {
    if (totalCount === 1) {
      return t.pricing.foundVariant;
    }
    return t.pricing.foundVariants.replace("{count}", String(totalCount));
  };

  return (
    <Box display="flex" flexDirection="column" gap={4}>
      <Text as="h2" variant="heading">
        {t.pricing.title}
      </Text>

      <Box display="flex" flexDirection="column" gap={2}>
        <Input
          type="text"
          label={t.pricing.searchLabel}
          value={searchQuery}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder={t.pricing.searchPlaceholder}
        />
        {totalCount > 0 && (
          <Text variant="caption" color="textNeutralSubdued">
            {getFoundText()}
          </Text>
        )}
      </Box>

      {fetching ? (
        <Text color="textNeutralSubdued">{t.pricing.loadingVariants}</Text>
      ) : variants.length === 0 ? (
        <Text color="textNeutralSubdued">
          {debouncedSearch ? t.pricing.noVariantsSearch : t.pricing.noVariantsAvailable}
        </Text>
      ) : (
        <>
          <VariantsTable variants={variants} t={t} />

          {/* Pagination */}
          {(pageInfo?.hasNextPage || cursor) && (
            <Box display="flex" justifyContent="space-between" alignItems="center" paddingTop={2}>
              <Button
                variant="tertiary"
                onClick={handlePrevPage}
                disabled={!cursor}
              >
                {t.pricing.firstPage}
              </Button>
              <Button
                variant="tertiary"
                onClick={handleNextPage}
                disabled={!pageInfo?.hasNextPage}
              >
                {t.pricing.nextPage}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  );
};

const VariantsTable = ({ variants, t }: { variants: VariantDetailsFragment[]; t: TranslationKeys }) => {
  return (
    <Box display="flex" flexDirection="column" gap={3}>
      {/* Desktop Table View */}
      <Box className="desktop-table">
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid #e0e0e0", fontWeight: 600 }}>
                {t.pricing.productVariant}
              </th>
              <th style={{ textAlign: "right", padding: "12px 8px", borderBottom: "1px solid #e0e0e0", fontWeight: 600 }}>
                {t.pricing.basePrice}
              </th>
              <th style={{ textAlign: "left", padding: "12px 8px", borderBottom: "1px solid #e0e0e0", fontWeight: 600 }}>
                {t.pricing.quantityPricingTiers}
              </th>
              <th style={{ width: "100px", padding: "12px 8px", borderBottom: "1px solid #e0e0e0" }}></th>
            </tr>
          </thead>
          <tbody>
            {variants.map((variant) => (
              <VariantRowDesktop variant={variant} key={variant.id} t={t} />
            ))}
          </tbody>
        </table>
      </Box>

      {/* Mobile Card View */}
      <Box className="mobile-cards" display="flex" flexDirection="column" gap={3}>
        {variants.map((variant) => (
          <VariantCardMobile variant={variant} key={variant.id} t={t} />
        ))}
      </Box>

      {/* Responsive CSS */}
      <style>{`
        .desktop-table {
          display: block;
        }
        .mobile-cards {
          display: none !important;
        }
        @media (max-width: 768px) {
          .desktop-table {
            display: none !important;
          }
          .mobile-cards {
            display: flex !important;
          }
        }
      `}</style>
    </Box>
  );
};

// Hook for managing pricing tiers
const usePricingTiers = (variant: VariantDetailsFragment) => {
  const existingPricing = useMemo(() => {
    try {
      return JSON.parse(variant.quantityPricing || "{}");
    } catch {
      return {};
    }
  }, [variant.quantityPricing]);

  const initialTiers: PricingTier[] = useMemo(() => {
    const entries = Object.entries(existingPricing);
    if (entries.length === 0) {
      return [{ quantity: "", price: "" }];
    }
    return entries.map(([qty, price]) => ({
      quantity: qty,
      price: String(price),
    }));
  }, [existingPricing]);

  const [tiers, setTiers] = useState<PricingTier[]>(initialTiers);
  const [_, setPricingMutation] = useSetQuantityPricingMutation();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const addTier = () => {
    setTiers([...tiers, { quantity: "", price: "" }]);
    setSaved(false);
  };

  const removeTier = (index: number) => {
    setTiers(tiers.filter((_, i) => i !== index));
    setSaved(false);
  };

  const updateTier = (index: number, field: keyof PricingTier, value: string) => {
    const newTiers = [...tiers];
    newTiers[index] = { ...newTiers[index], [field]: value };
    setTiers(newTiers);
    setSaved(false);
  };

  const savePricing = async () => {
    setSaving(true);

    // Build pricing object from valid tiers
    const pricing: Record<string, string> = {};
    tiers.forEach((tier) => {
      const qty = parseInt(tier.quantity, 10);
      const price = parseFloat(tier.price);
      if (!isNaN(qty) && qty > 0 && !isNaN(price) && price >= 0) {
        pricing[String(qty)] = tier.price;
      }
    });

    // Sort by quantity for consistent storage
    const sortedPricing: Record<string, string> = {};
    Object.keys(pricing)
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
      .forEach((key) => {
        sortedPricing[key] = pricing[key];
      });

    await setPricingMutation({
      id: variant.id,
      pricing: JSON.stringify(sortedPricing),
    });

    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return {
    tiers,
    addTier,
    removeTier,
    updateTier,
    savePricing,
    saving,
    saved,
  };
};

// Desktop row component
const VariantRowDesktop = ({ variant, t }: { variant: VariantDetailsFragment; t: TranslationKeys }) => {
  const { tiers, addTier, removeTier, updateTier, savePricing, saving, saved } =
    usePricingTiers(variant);

  const cellStyle = { padding: "12px 8px", borderBottom: "1px solid #e0e0e0", verticalAlign: "top" as const };

  const getSaveButtonText = () => {
    if (saving) return t.pricing.saving;
    if (saved) return t.pricing.saved;
    return t.pricing.save;
  };

  return (
    <tr>
      <td style={cellStyle}>
        <Text as="span" variant="bodyStrong">
          {variant.product.name}
        </Text>
        <br />
        <Text as="span" variant="caption" color="textNeutralSubdued">
          {variant.name}
        </Text>
      </td>
      <td style={{ ...cellStyle, textAlign: "right" }}>
        <Text>{formatPrice(variant.pricing?.price?.gross.amount)}</Text>
        <br />
        <Text as="span" variant="caption" color="textNeutralSubdued">
          {variant.pricing?.price?.gross.currency || "USD"}
        </Text>
      </td>
      <td style={cellStyle}>
        <Box display="flex" flexDirection="column" gap={2}>
          {tiers.map((tier, index) => (
            <Box key={index} display="flex" alignItems="center" gap={2}>
              <div style={{ width: "100px" }}>
                <Input
                  type="number"
                  size="small"
                  value={tier.quantity}
                  onChange={(e) => updateTier(index, "quantity", e.target.value)}
                  placeholder={t.pricing.qty}
                  min="1"
                />
              </div>
              <Text color="textNeutralSubdued">@</Text>
              <div style={{ width: "120px" }}>
                <Input
                  type="number"
                  size="small"
                  value={tier.price}
                  onChange={(e) => updateTier(index, "price", e.target.value)}
                  placeholder={t.pricing.price}
                  min="0"
                  step="0.01"
                  endAdornment={
                    <Text variant="caption" color="textNeutralSubdued">
                      {variant.pricing?.price?.gross.currency || "USD"}
                    </Text>
                  }
                />
              </div>
              {tiers.length > 1 && (
                <Button
                  variant="tertiary"
                  size="small"
                  onClick={() => removeTier(index)}
                >
                  {t.pricing.remove}
                </Button>
              )}
            </Box>
          ))}
          <Box>
            <Button variant="tertiary" size="small" onClick={addTier}>
              {t.pricing.addTier}
            </Button>
          </Box>
        </Box>
      </td>
      <td style={cellStyle}>
        <Box display="flex" flexDirection="column" gap={1}>
          <Button
            variant="primary"
            size="small"
            onClick={savePricing}
            disabled={saving}
          >
            {getSaveButtonText()}
          </Button>
        </Box>
      </td>
    </tr>
  );
};

// Mobile card component
const VariantCardMobile = ({ variant, t }: { variant: VariantDetailsFragment; t: TranslationKeys }) => {
  const { tiers, addTier, removeTier, updateTier, savePricing, saving, saved } =
    usePricingTiers(variant);

  const getSaveButtonText = () => {
    if (saving) return t.pricing.saving;
    if (saved) return t.pricing.saved;
    return t.pricing.savePricing;
  };

  return (
    <Box
      padding={4}
      borderRadius={2}
      style={{
        border: "1px solid #e0e0e0",
        backgroundColor: "#fafafa",
      }}
    >
      {/* Product Info */}
      <Box marginBottom={3}>
        <Text as="span" variant="bodyStrong">
          {variant.product.name}
        </Text>
        <br />
        <Text as="span" variant="caption" color="textNeutralSubdued">
          {variant.name}
        </Text>
        <Box display="flex" justifyContent="space-between" alignItems="center" marginTop={2}>
          <Text variant="caption" color="textNeutralSubdued">
            {t.pricing.basePrice}:
          </Text>
          <Text>
            {formatPrice(variant.pricing?.price?.gross.amount)}{" "}
            {variant.pricing?.price?.gross.currency || "USD"}
          </Text>
        </Box>
      </Box>

      {/* Pricing Tiers */}
      <Box marginBottom={3}>
        <Text as="span" variant="caption" color="textNeutralSubdued">
          {t.pricing.quantityPricingTiers}:
        </Text>
        <Box display="flex" flexDirection="column" gap={2} marginTop={2}>
          {tiers.map((tier, index) => (
            <Box
              key={index}
              display="flex"
              flexDirection="column"
              gap={2}
              padding={2}
              style={{
                backgroundColor: "#f0f0f0",
                borderRadius: "4px",
              }}
            >
              <Box display="flex" gap={2} alignItems="center">
                <div style={{ flex: 1 }}>
                  <Input
                    type="number"
                    size="small"
                    label={t.pricing.quantity}
                    value={tier.quantity}
                    onChange={(e) => updateTier(index, "quantity", e.target.value)}
                    placeholder={t.pricing.minQty}
                    min="1"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Input
                    type="number"
                    size="small"
                    label={t.pricing.price}
                    value={tier.price}
                    onChange={(e) => updateTier(index, "price", e.target.value)}
                    placeholder={t.pricing.unitPrice}
                    min="0"
                    step="0.01"
                  />
                </div>
              </Box>
              {tiers.length > 1 && (
                <Button
                  variant="tertiary"
                  size="small"
                  onClick={() => removeTier(index)}
                >
                  {t.pricing.removeTier}
                </Button>
              )}
            </Box>
          ))}
        </Box>
        <Box marginTop={2}>
          <Button variant="tertiary" size="small" onClick={addTier}>
            {t.pricing.addPricingTier}
          </Button>
        </Box>
      </Box>

      {/* Save Button */}
      <Button
        variant="primary"
        onClick={savePricing}
        disabled={saving}
        style={{ width: "100%" }}
      >
        {getSaveButtonText()}
      </Button>
    </Box>
  );
};

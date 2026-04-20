import { useMutation, useQuery } from "@tanstack/react-query";
import { createClient, fetchExchange } from "urql";
import {
  CheckoutDetailsFragment,
  GetFirstVariantsDocument,
  VariantDetailsFragment,
} from "../../generated/graphql";
import { useState } from "react";
import { getVariantPrice } from "../lib/get-variant-price";
import { AddToCartResponseData } from "./api/add-to-cart";
import { formatPrice } from "../lib/format-price";
import { DEFAULT_CHANNEL, SALEOR_API_URL } from "../const";
import { useTranslations, type TranslationKeys } from "../lib/i18n";

const getVariants = () => {
  const client = createClient({
    url: SALEOR_API_URL,
    exchanges: [fetchExchange],
  });
  return client.query(GetFirstVariantsDocument, { channel: DEFAULT_CHANNEL }).toPromise();
};

const CheckoutDetails = ({ checkout, t }: { checkout: CheckoutDetailsFragment; t: TranslationKeys }) => {
  return (
    <div>
      <h3>{t.storefront.checkout}</h3>
      <p>{t.storefront.checkoutId} {checkout.id}</p>
      <p>{t.storefront.lines}</p>

      <table>
        <thead>
          <tr>
            <th style={{ textAlign: "left" }}>{t.storefront.variant}</th>
            <th style={{ textAlign: "right" }}>{t.storefront.quantityHeader}</th>
            <th style={{ textAlign: "right" }}>{t.storefront.priceHeader}</th>
            <th style={{ textAlign: "right" }}>{t.storefront.lineTotal}</th>
          </tr>
        </thead>
        <tbody>
          {checkout.lines?.map((line) => (
            <tr key={line.id}>
              <td style={{ textAlign: "left", paddingRight: 40 }}>
                {line.variant.product.name} - {line.variant.name}
              </td>
              <td style={{ textAlign: "right" }}>{line.quantity}</td>
              <td style={{ textAlign: "right", paddingLeft: 40 }}>
                {formatPrice(line.unitPrice.gross.amount)}
              </td>
              <td style={{ textAlign: "right", paddingLeft: 40 }}>
                {formatPrice(line.totalPrice?.gross.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>{t.storefront.checkoutSubtotal} {formatPrice(checkout.subtotalPrice.gross.amount)}</p>
    </div>
  );
};

interface VariantDetailsProps {
  checkoutId: string | undefined;
  variant: VariantDetailsFragment;
  setCheckout: (checkout: CheckoutDetailsFragment | undefined) => void;
  t: TranslationKeys;
}

const VariantDetails = ({ checkoutId, variant, setCheckout, t }: VariantDetailsProps) => {
  const [quantity, setQuantity] = useState<number>(1);

  const addButtonLabel = checkoutId ? t.storefront.addAnotherItem : t.storefront.createCheckoutAndAdd;

  const checkoutMutation = useMutation({
    mutationFn: ({
      variantId,
      quantity,
      checkoutId,
    }: {
      variantId: string;
      quantity: number;
      checkoutId: string | undefined;
    }) => {
      return fetch("/api/add-to-cart", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ variantId, quantity, checkoutId }),
      });
    },
    onSuccess: async (data) => {
      const responseData = (await data.json()) as AddToCartResponseData;
      if ("checkout" in responseData) {
        console.info("Add to cart succeeded");
        setCheckout(responseData.checkout);
      }
    },
    onError: (error) => {
      console.error("Adding to cart operation has failed");
      console.error(error);
      setCheckout(undefined);
    },
  });

  return (
    <>
      <h2>{t.storefront.productDetails}</h2>
      <h3>
        {variant.product.name} - {variant.name}
      </h3>

      {variant.quantityPricing ? (
        <p>{t.storefront.hasQuantityPricing} {variant.quantityPricing}</p>
      ) : (
        <p>{t.storefront.noQuantityPricing}</p>
      )}

      <label htmlFor="Quantity">{t.storefront.quantityLabel}</label>

      <input
        type="number"
        id="quantity"
        name="quantity"
        min="1"
        max="10000"
        value={quantity}
        onChange={(x) => setQuantity(parseInt(x.target.value, 10))}
      />

      <p>
        {t.storefront.priceWithQuantity}{" "}
        {formatPrice(
          getVariantPrice(quantity, variant.quantityPricing, variant.pricing?.price?.gross.amount)
        )}
      </p>

      <p>{t.storefront.basePriceLabel} {formatPrice(variant.pricing?.price?.gross.amount)}</p>

      <button
        disabled={checkoutMutation.isLoading}
        onClick={() =>
          checkoutMutation.mutate({
            quantity,
            variantId: variant.id,
            checkoutId: checkoutId,
          })
        }
      >
        {addButtonLabel}
      </button>
    </>
  );
};

const StorefrontPage = () => {
  const t = useTranslations();
  const { data } = useQuery({ queryKey: ["variants"], queryFn: getVariants });
  const [chosenVariantId, setVariantId] = useState<undefined | string>();
  const [checkout, setCheckout] = useState<CheckoutDetailsFragment | undefined>();

  const variants = data?.data?.productVariants?.edges.map((variant) => variant.node) || [];
  const chosenVariant = variants.find((variant) => variant.id === chosenVariantId);

  return (
    <>
      <h1>{t.storefront.title}</h1>
      <h2>{t.storefront.firstVariants}</h2>
      <ul>
        {variants.map((variant) => (
          <li key={variant.id}>
            <button
              onClick={() => setVariantId(variant.id)}
              disabled={variant.id === chosenVariant?.id}
            >
              {t.storefront.chooseVariant}
            </button>{" "}
            {variant.product.name} - {variant.name}
          </li>
        ))}
      </ul>
      {!chosenVariant ? (
        <h2>{t.storefront.pleaseChooseVariant}</h2>
      ) : (
        <VariantDetails
          checkoutId={checkout?.id}
          variant={chosenVariant}
          setCheckout={setCheckout}
          t={t}
        />
      )}

      {!!checkout && <CheckoutDetails checkout={checkout} t={t} />}
    </>
  );
};

export default StorefrontPage;

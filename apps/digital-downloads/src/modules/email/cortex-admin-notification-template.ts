export interface CortexPurchaseInfo {
  productName: string;
  variantName?: string;
  price?: {
    amount: number;
    currency: string;
  };
}

export interface CortexAdminNotificationTemplateInput {
  orderNumber: string;
  customerEmail: string;
  cortexUsername?: string;
  cortexFollowConfirmed?: boolean;
  orderCreated: string;
  cortexProducts: CortexPurchaseInfo[];
}

export function generateCortexAdminNotificationEmail(
  input: CortexAdminNotificationTemplateInput,
): {
  subject: string;
  html: string;
  text: string;
} {
  const {
    orderNumber,
    customerEmail,
    cortexUsername,
    cortexFollowConfirmed,
    orderCreated,
    cortexProducts,
  } = input;

  const subject = `🎸 New Cortex Purchase - Order #${orderNumber}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>New Cortex Purchase Notification</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #1a1a1a;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        .header {
            text-align: center;
            border-bottom: 3px solid #2563eb;
            padding-bottom: 24px;
            margin-bottom: 32px;
        }
        .title {
            color: #2563eb;
            font-size: 24px;
            font-weight: 700;
            margin: 0 0 8px 0;
        }
        .subtitle {
            color: #6b7280;
            font-size: 16px;
            margin: 0;
        }
        .info-section {
            background-color: #f0f9ff;
            border-left: 4px solid #2563eb;
            padding: 20px 24px;
            margin: 24px 0;
            border-radius: 4px;
        }
        .info-row {
            display: flex;
            margin-bottom: 12px;
            align-items: baseline;
        }
        .info-row:last-child {
            margin-bottom: 0;
        }
        .info-label {
            font-weight: 600;
            color: #374151;
            min-width: 180px;
            flex-shrink: 0;
        }
        .info-value {
            color: #1a1a1a;
            word-break: break-word;
        }
        .cortex-badge {
            display: inline-block;
            background-color: #2563eb;
            color: #ffffff;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        .products-section {
            margin: 32px 0;
        }
        .products-header {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 16px;
        }
        .product-item {
            background-color: #fafafa;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            padding: 16px 20px;
            margin-bottom: 12px;
        }
        .product-name {
            font-weight: 600;
            color: #1a1a1a;
            font-size: 15px;
            margin-bottom: 4px;
        }
        .product-variant {
            color: #6b7280;
            font-size: 13px;
            margin-bottom: 8px;
        }
        .product-price {
            color: #059669;
            font-weight: 600;
            font-size: 14px;
        }
        .status-badge {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .status-confirmed {
            background-color: #d1fae5;
            color: #065f46;
        }
        .status-not-confirmed {
            background-color: #fee2e2;
            color: #991b1b;
        }
        .footer {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 2px solid #e5e7eb;
            text-align: center;
            color: #6b7280;
            font-size: 13px;
        }
        .timestamp {
            color: #9ca3af;
            font-size: 12px;
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="title">🎸 New Cortex Purchase</div>
            <p class="subtitle">Order #${orderNumber}</p>
        </div>

        <div class="info-section">
            <div class="info-row">
                <span class="info-label">Customer Email:</span>
                <span class="info-value">${customerEmail}</span>
            </div>
            ${
              cortexUsername
                ? `
            <div class="info-row">
                <span class="info-label">Cortex Username:</span>
                <span class="info-value">${cortexUsername}</span>
            </div>
            `
                : ""
            }
            ${
              cortexFollowConfirmed !== undefined
                ? `
            <div class="info-row">
                <span class="info-label">Follow Confirmed:</span>
                <span class="info-value">
                    <span class="status-badge ${cortexFollowConfirmed ? "status-confirmed" : "status-not-confirmed"}">
                        ${cortexFollowConfirmed ? "✓ Yes" : "✗ No"}
                    </span>
                </span>
            </div>
            `
                : ""
            }
            <div class="info-row">
                <span class="info-label">Order Date:</span>
                <span class="info-value">${new Date(orderCreated).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZoneName: "short",
                })}</span>
            </div>
        </div>

        <div class="products-section">
            <div class="products-header">Cortex Products Purchased:</div>
            ${cortexProducts
              .map(
                (product) => `
                <div class="product-item">
                    <div class="product-name">
                        ${product.productName}
                        <span class="cortex-badge">Cortex</span>
                    </div>
                    ${
                      product.variantName
                        ? `<div class="product-variant">${product.variantName}</div>`
                        : ""
                    }
                    ${
                      product.price
                        ? `<div class="product-price">${product.price.amount} ${product.price.currency}</div>`
                        : ""
                    }
                </div>
            `,
              )
              .join("")}
        </div>

        <div class="footer">
            <p>This is an automated notification for Cortex platform purchases.</p>
            <p class="timestamp">Generated at ${new Date().toISOString()}</p>
        </div>
    </div>
</body>
</html>
  `.trim();

  const text = `
═══════════════════════════════════════════════════
🎸 NEW CORTEX PURCHASE
Order #${orderNumber}
═══════════════════════════════════════════════════

CUSTOMER INFORMATION:
─────────────────────────────────────────────────
Customer Email:         ${customerEmail}
${cortexUsername ? `Cortex Username:        ${cortexUsername}` : ""}
${cortexFollowConfirmed !== undefined ? `Follow Confirmed:       ${cortexFollowConfirmed ? "Yes" : "No"}` : ""}
Order Date:             ${new Date(orderCreated).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  })}

CORTEX PRODUCTS PURCHASED:
─────────────────────────────────────────────────
${cortexProducts
  .map(
    (product, index) => `
${index + 1}. ${product.productName} [CORTEX]
   ${product.variantName ? `Variant: ${product.variantName}` : ""}
   ${product.price ? `Price: ${product.price.amount} ${product.price.currency}` : ""}
`,
  )
  .join("\n")}

═══════════════════════════════════════════════════
This is an automated notification for Cortex platform purchases.
Generated at ${new Date().toISOString()}
  `.trim();

  return { subject, html, text };
}

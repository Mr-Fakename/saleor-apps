export interface CortexProduct {
  productName: string;
  variantName?: string;
  productType: string;
  platformAttribute: string;
}

export interface CortexAdminNotificationInput {
  orderNumber: string;
  orderId: string;
  customerEmail: string;
  customerName?: string;
  cortexCloudUsername?: string;
  cortexProducts: CortexProduct[];
  orderDate: string;
}

export function generateCortexAdminNotificationEmail(input: CortexAdminNotificationInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { orderNumber, orderId, customerEmail, customerName, cortexCloudUsername, cortexProducts, orderDate } = input;

  const subject = `⚠️ ACTION REQUIRED: Cortex Order #${orderNumber}`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Cortex Order Notification - Action Required</title>
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
            border-bottom: 3px solid #dc2626;
            padding-bottom: 24px;
            margin-bottom: 32px;
        }
        .logo {
            max-width: 200px;
            height: auto;
            margin: 0 auto 16px auto;
            display: block;
        }
        h1 {
            color: #dc2626;
            font-size: 22px;
            font-weight: 600;
            margin: 12px 0 0 0;
        }
        .alert-badge {
            display: inline-block;
            background-color: #dc2626;
            color: #ffffff;
            padding: 4px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-top: 8px;
        }
        .info-section {
            background-color: #fef2f2;
            border: 1px solid #fecaca;
            border-left: 4px solid #dc2626;
            padding: 20px 24px;
            margin: 24px 0;
            border-radius: 4px;
        }
        .info-section h2 {
            color: #dc2626;
            font-size: 16px;
            font-weight: 600;
            margin: 0 0 12px 0;
        }
        .info-row {
            display: flex;
            padding: 8px 0;
            border-bottom: 1px solid #fee2e2;
        }
        .info-row:last-child {
            border-bottom: none;
        }
        .info-label {
            font-weight: 600;
            color: #6b7280;
            min-width: 180px;
        }
        .info-value {
            color: #1a1a1a;
            flex: 1;
        }
        .cortex-username {
            background-color: #fef3c7;
            border: 2px solid #fcd34d;
            padding: 12px 16px;
            border-radius: 6px;
            margin: 16px 0;
            font-family: 'Courier New', monospace;
            font-size: 16px;
            font-weight: 600;
            color: #92400e;
            text-align: center;
        }
        .products-section {
            margin: 24px 0;
        }
        .products-header {
            font-size: 16px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 16px;
            padding-bottom: 8px;
            border-bottom: 2px solid #e5e7eb;
        }
        .product-item {
            background-color: #f9fafb;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 12px;
        }
        .product-name {
            font-weight: 600;
            color: #1a1a1a;
            font-size: 15px;
            margin-bottom: 4px;
        }
        .product-detail {
            color: #6b7280;
            font-size: 13px;
            margin: 2px 0;
        }
        .action-box {
            background-color: #fef2f2;
            border: 2px solid #dc2626;
            border-radius: 8px;
            padding: 24px;
            margin: 32px 0;
            text-align: center;
        }
        .action-box h3 {
            color: #dc2626;
            font-size: 18px;
            font-weight: 600;
            margin: 0 0 12px 0;
        }
        .action-box p {
            margin: 8px 0;
            color: #374151;
            font-size: 14px;
        }
        .action-list {
            text-align: left;
            margin: 16px 0 0 0;
            padding: 0 0 0 20px;
        }
        .action-list li {
            margin: 8px 0;
            color: #374151;
        }
        .footer {
            margin-top: 32px;
            padding-top: 20px;
            border-top: 2px solid #e5e7eb;
            text-align: center;
            color: #6b7280;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <img class="logo" src="https://cdn.sonicdrivestudio.com/Logo%20complete-min.png" alt="Sonic Drive Studio">
            <h1>🚨 Cortex Order Received</h1>
            <span class="alert-badge">Action Required</span>
        </div>

        <div class="info-section">
            <h2>Order Information</h2>
            <div class="info-row">
                <span class="info-label">Order Number:</span>
                <span class="info-value">#${orderNumber}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order ID:</span>
                <span class="info-value">${orderId}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Order Date:</span>
                <span class="info-value">${new Date(orderDate).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}</span>
            </div>
        </div>

        <div class="info-section">
            <h2>Customer Information</h2>
            <div class="info-row">
                <span class="info-label">Email:</span>
                <span class="info-value">${customerEmail}</span>
            </div>
            ${
              customerName
                ? `<div class="info-row">
                <span class="info-label">Name:</span>
                <span class="info-value">${customerName}</span>
            </div>`
                : ""
            }
            ${
              cortexCloudUsername
                ? `<div class="info-row">
                <span class="info-label">Cortex Cloud Username:</span>
                <span class="info-value"><strong>${cortexCloudUsername}</strong></span>
            </div>`
                : ""
            }
        </div>

        ${
          cortexCloudUsername
            ? `<div class="cortex-username">
            🎯 Cortex Username: ${cortexCloudUsername}
        </div>`
            : ""
        }

        <div class="products-section">
            <div class="products-header">Cortex Products Ordered</div>
            ${cortexProducts
              .map(
                (product) => `
                <div class="product-item">
                    <div class="product-name">${product.productName}</div>
                    ${product.variantName ? `<div class="product-detail">Variant: ${product.variantName}</div>` : ""}
                    <div class="product-detail">Type: ${product.productType}</div>
                    <div class="product-detail">Platform: ${product.platformAttribute}</div>
                </div>
            `,
              )
              .join("")}
        </div>

        <div class="action-box">
            <h3>⚡ Action Required</h3>
            <p>A customer has purchased Cortex products. Please complete the following steps:</p>
            <ol class="action-list">
                <li>Log into the Cortex Cloud admin panel</li>
                <li><strong>Add user to Cortex Cloud:</strong>
                    <span style="background-color: #fef3c7; padding: 4px 8px; border-radius: 4px; font-family: 'Courier New', monospace; font-weight: 700; color: #92400e; font-size: 15px;">
                        ${cortexCloudUsername || customerEmail}
                    </span>
                </li>
                <li>Grant access to the purchased Cortex products listed above</li>
                <li>Verify the customer can access their products</li>
            </ol>
        </div>

        <div class="footer">
            <p>This is an automated notification from Sonic Drive Studio Digital Downloads app.</p>
            <p>Order #${orderNumber} • ${new Date(orderDate).toLocaleDateString()}</p>
        </div>
    </div>
</body>
</html>
  `.trim();

  const text = `
═══════════════════════════════════════════════════
🚨 CORTEX ORDER NOTIFICATION - ACTION REQUIRED
═══════════════════════════════════════════════════

A customer has purchased Cortex products and requires admin action.

ORDER INFORMATION:
═══════════════════════════════════════════════════
Order Number: #${orderNumber}
Order ID: ${orderId}
Order Date: ${new Date(orderDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}

CUSTOMER INFORMATION:
═══════════════════════════════════════════════════
Email: ${customerEmail}
${customerName ? `Name: ${customerName}` : ""}
${cortexCloudUsername ? `Cortex Cloud Username: ${cortexCloudUsername}` : ""}

${cortexCloudUsername ? `🎯 CORTEX USERNAME: ${cortexCloudUsername}\n` : ""}
CORTEX PRODUCTS ORDERED:
═══════════════════════════════════════════════════
${cortexProducts
  .map(
    (product, index) => `
${index + 1}. ${product.productName}
   ${product.variantName ? `Variant: ${product.variantName}` : ""}
   Type: ${product.productType}
   Platform: ${product.platformAttribute}`,
  )
  .join("\n")}

⚡ ACTION REQUIRED:
═══════════════════════════════════════════════════
1. Log into the Cortex Cloud admin panel
2. Add user to Cortex Cloud:
   >>> ${cortexCloudUsername || customerEmail} <<<
3. Grant access to the purchased Cortex products listed above
4. Verify the customer can access their products

---
This is an automated notification from Sonic Drive Studio Digital Downloads app.
Order #${orderNumber} • ${new Date(orderDate).toLocaleDateString()}
  `.trim();

  return { subject, html, text };
}

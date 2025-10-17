import type { DownloadToken } from "@/modules/download-tokens/domain/download-token";

export interface OrderConfirmationTemplateInput {
  orderNumber: string;
  customerEmail: string;
  downloadTokens: DownloadToken[];
  appBaseUrl: string;
}

export function generateOrderConfirmationEmail(input: OrderConfirmationTemplateInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { orderNumber, customerEmail, downloadTokens, appBaseUrl } = input;

  const subject = `Order ${orderNumber} Confirmed - Your Digital Downloads`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Order Confirmation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
        }
        .container {
            background-color: #ffffff;
            border-radius: 8px;
            padding: 32px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }
        .header {
            border-bottom: 2px solid #f0f0f0;
            padding-bottom: 20px;
            margin-bottom: 30px;
        }
        h1 {
            color: #1a1a1a;
            font-size: 24px;
            margin: 0 0 8px 0;
        }
        .order-number {
            color: #666;
            font-size: 14px;
        }
        .downloads-section {
            margin: 30px 0;
        }
        .downloads-header {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 16px;
        }
        .download-item {
            background-color: #f8f9fa;
            border: 1px solid #e9ecef;
            border-radius: 6px;
            padding: 16px;
            margin-bottom: 12px;
        }
        .product-name {
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 4px;
        }
        .variant-name {
            color: #666;
            font-size: 14px;
            margin-bottom: 12px;
        }
        .download-button {
            display: inline-block;
            background-color: #0066cc;
            color: #ffffff !important;
            text-decoration: none;
            padding: 10px 20px;
            border-radius: 4px;
            font-weight: 500;
            font-size: 14px;
            transition: background-color 0.2s;
        }
        .download-button:hover {
            background-color: #0052a3;
        }
        .expiry-info {
            color: #666;
            font-size: 13px;
            margin-top: 8px;
        }
        .info-box {
            background-color: #e3f2fd;
            border-left: 4px solid #2196f3;
            padding: 16px;
            margin: 20px 0;
            border-radius: 4px;
        }
        .info-box p {
            margin: 0;
            color: #1565c0;
            font-size: 14px;
        }
        .footer {
            margin-top: 40px;
            padding-top: 20px;
            border-top: 2px solid #f0f0f0;
            text-align: center;
            color: #666;
            font-size: 13px;
        }
        .help-text {
            margin-top: 16px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>✅ Order Confirmed!</h1>
            <p class="order-number">Order #${orderNumber}</p>
        </div>

        <p>Hi there,</p>
        <p>Thank you for your order! Your payment has been confirmed and your digital products are ready to download.</p>

        <div class="downloads-section">
            <div class="downloads-header">📥 Your Digital Downloads</div>

            ${downloadTokens
              .map(
                (token) => `
                <div class="download-item">
                    <div class="product-name">${token.productName}</div>
                    ${
                      token.variantName
                        ? `<div class="variant-name">${token.variantName}</div>`
                        : ""
                    }
                    <a href="${appBaseUrl}/api/downloads/${token.token}" class="download-button">
                        Download Now
                    </a>
                    <div class="expiry-info">
                        Valid until ${new Date(token.expiresAt).toLocaleDateString("en-US", {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })} • Maximum ${token.maxDownloads} downloads
                    </div>
                </div>
            `,
              )
              .join("")}
        </div>

        <div class="info-box">
            <p>💡 <strong>Important:</strong> Download links expire after ${Math.round(
              (new Date(downloadTokens[0].expiresAt).getTime() - Date.now()) / (1000 * 60 * 60),
            )} hours. Make sure to download your files before they expire!</p>
        </div>

        <div class="footer">
            <p>If you have any questions or issues downloading your files, please contact our support team.</p>
            <p class="help-text">This email was sent to ${customerEmail}</p>
        </div>
    </div>
</body>
</html>
  `.trim();

  const text = `
ORDER CONFIRMED - Order #${orderNumber}

Hi there,

Thank you for your order! Your payment has been confirmed and your digital products are ready to download.

YOUR DIGITAL DOWNLOADS:

${downloadTokens
  .map(
    (token, index) => `
${index + 1}. ${token.productName}${token.variantName ? ` - ${token.variantName}` : ""}
   Download: ${appBaseUrl}/api/downloads/${token.token}
   Valid until: ${new Date(token.expiresAt).toLocaleDateString("en-US", {
     year: "numeric",
     month: "long",
     day: "numeric",
     hour: "2-digit",
     minute: "2-digit",
   })}
   Maximum downloads: ${token.maxDownloads}
`,
  )
  .join("\n")}

IMPORTANT: Download links expire after ${Math.round(
    (new Date(downloadTokens[0].expiresAt).getTime() - Date.now()) / (1000 * 60 * 60),
  )} hours. Make sure to download your files before they expire!

If you have any questions or issues downloading your files, please contact our support team.

This email was sent to ${customerEmail}
  `.trim();

  return { subject, html, text };
}

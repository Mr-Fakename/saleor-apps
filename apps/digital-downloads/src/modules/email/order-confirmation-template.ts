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

  const subject = `Your Sonic Drive Studio Downloads Are Ready! (Order ${orderNumber})`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Your Digital Downloads - Sonic Drive Studio</title>
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
        .brand {
            color: #dc2626;
            font-size: 28px;
            font-weight: 700;
            margin: 0 0 8px 0;
            letter-spacing: -0.5px;
        }
        h1 {
            color: #1a1a1a;
            font-size: 22px;
            font-weight: 600;
            margin: 12px 0 0 0;
        }
        .order-number {
            color: #6b7280;
            font-size: 14px;
            margin-top: 8px;
        }
        .message {
            background-color: #fafafa;
            border-left: 4px solid #dc2626;
            padding: 20px 24px;
            margin: 24px 0;
            border-radius: 4px;
            color: #374151;
            font-size: 15px;
            line-height: 1.7;
        }
        .downloads-section {
            margin: 32px 0;
        }
        .downloads-header {
            font-size: 18px;
            font-weight: 600;
            color: #1a1a1a;
            margin-bottom: 20px;
            display: flex;
            align-items: center;
        }
        .downloads-header::before {
            content: "📥";
            margin-right: 8px;
            font-size: 20px;
        }
        .download-item {
            background-color: #ffffff;
            border: 2px solid #e5e7eb;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 16px;
            transition: border-color 0.2s;
        }
        .download-item:hover {
            border-color: #dc2626;
        }
        .product-name {
            font-weight: 600;
            color: #1a1a1a;
            font-size: 16px;
            margin-bottom: 6px;
        }
        .variant-name {
            color: #6b7280;
            font-size: 14px;
            margin-bottom: 16px;
        }
        .download-button {
            display: inline-block;
            background-color: #dc2626;
            color: #ffffff !important;
            text-decoration: none;
            padding: 12px 28px;
            border-radius: 6px;
            font-weight: 600;
            font-size: 14px;
            transition: background-color 0.2s;
        }
        .download-button:hover {
            background-color: #b91c1c;
        }
        .expiry-info {
            color: #6b7280;
            font-size: 13px;
            margin-top: 12px;
        }
        .info-box {
            background-color: #fef2f2;
            border: 1px solid #fecaca;
            border-left: 4px solid #dc2626;
            padding: 16px 20px;
            margin: 24px 0;
            border-radius: 4px;
        }
        .info-box p {
            margin: 0;
            color: #991b1b;
            font-size: 14px;
            line-height: 1.6;
        }
        .signature {
            margin-top: 32px;
            padding: 24px;
            background-color: #fafafa;
            border-radius: 8px;
            font-size: 15px;
            line-height: 1.8;
            color: #374151;
        }
        .signature-name {
            font-weight: 600;
            color: #1a1a1a;
            margin-top: 16px;
        }
        .signature-brand {
            color: #dc2626;
            font-weight: 600;
        }
        .footer {
            margin-top: 40px;
            padding-top: 24px;
            border-top: 2px solid #e5e7eb;
            text-align: center;
            color: #6b7280;
            font-size: 13px;
        }
        .help-text {
            margin-top: 12px;
            color: #9ca3af;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="brand">SONIC DRIVE STUDIO</div>
            <h1>Your Digital Downloads Are Ready!</h1>
            <p class="order-number">Order #${orderNumber}</p>
        </div>

        <div class="message">
            <p>Thank you so much for buying these products. I hope you enjoy them as much as I've been enjoying them! Be sure to follow Sonic Drive Studio social accounts so that you can stay up to date on all my upcoming releases. There's a LOT of cool stuff coming!</p>
            <p style="margin-top: 12px;">And of course if you like them it would be great if you could tell your friends, that would help a lot! :)</p>
        </div>

        <div class="downloads-section">
            <div class="downloads-header">Your Digital Downloads</div>

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
            <p><strong>⏰ Important:</strong> Download links expire after ${Math.round(
              (new Date(downloadTokens[0].expiresAt).getTime() - Date.now()) / (1000 * 60 * 60),
            )} hours. Make sure to download your files before they expire!</p>
        </div>

        <div class="signature">
            <p>Cheers,</p>
            <p class="signature-name">Jon</p>
            <p class="signature-brand">Sonic Drive Studio</p>
        </div>

        <div class="footer">
            <p>If you have any questions or issues downloading your files, please reach out!</p>
            <p class="help-text">This email was sent to ${customerEmail}</p>
        </div>
    </div>
</body>
</html>
  `.trim();

  const text = `
═══════════════════════════════════════════════════
SONIC DRIVE STUDIO
Your Digital Downloads Are Ready!
Order #${orderNumber}
═══════════════════════════════════════════════════

Thank you so much for buying these products. I hope you enjoy them as much as I've been enjoying them! Be sure to follow Sonic Drive Studio social accounts so that you can stay up to date on all my upcoming releases. There's a LOT of cool stuff coming!

And of course if you like them it would be great if you could tell your friends, that would help a lot! :)

YOUR DIGITAL DOWNLOADS:
═══════════════════════════════════════════════════

${downloadTokens
  .map(
    (token, index) => `
${index + 1}. ${token.productName}${token.variantName ? ` - ${token.variantName}` : ""}

   Download Link:
   ${appBaseUrl}/api/downloads/${token.token}

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

═══════════════════════════════════════════════════
⏰ IMPORTANT: Download links expire after ${Math.round(
    (new Date(downloadTokens[0].expiresAt).getTime() - Date.now()) / (1000 * 60 * 60),
  )} hours.
Make sure to download your files before they expire!
═══════════════════════════════════════════════════

Cheers,

Jon
Sonic Drive Studio

---
If you have any questions or issues downloading your files, please reach out!
This email was sent to ${customerEmail}
  `.trim();

  return { subject, html, text };
}

import { NextApiRequest, NextApiResponse } from 'next';
import { getSaleorHeaders } from '@saleor/app-sdk/headers';
import getRawBody from 'raw-body';
import { createLogger } from '../../../logger';
import { SALEOR_API_URL_HEADER } from '@saleor/app-sdk/const';
import { normalizeSaleorApiUrl } from '../../../lib/normalize-saleor-api-url';
import { saleorApp } from '../../../saleor-app';
import { createGraphQLClient } from '../../../lib/create-graphql-client';
import { AddressV2Shape } from '../../../modules/app-configuration/schema-v2/app-config-schema.v2';
import { GetAppConfigurationV2Service } from '../../../modules/app-configuration/schema-v2/get-app-configuration.v2.service';
import { InvoiceCreateNotifier } from '../../../modules/invoices/invoice-create-notifier/invoice-create-notifier';
import { hashInvoiceFilename } from '../../../modules/invoices/invoice-file-name/hash-invoice-filename';
import { resolveTempPdfFileLocation } from '../../../modules/invoices/invoice-file-name/resolve-temp-pdf-file-location';
import { MicroinvoiceInvoiceGenerator } from '../../../modules/invoices/invoice-generator/microinvoice/microinvoice-invoice-generator';
import {
  InvoiceNumberGenerationStrategy,
  InvoiceNumberGenerator,
} from '../../../modules/invoices/invoice-number-generator/invoice-number-generator';
import { SaleorInvoiceUploader } from '../../../modules/invoices/invoice-uploader/saleor-invoice-uploader';
import { ShopInfoFetcher } from '../../../modules/shop-info/shop-info-fetcher';
import { shopInfoQueryToAddressShape } from '../../../modules/shop-info/shop-info-query-to-address-shape';
import { AppConfigV2 } from '../../../modules/app-configuration/schema-v2/app-config';

const logger = createLogger('InvoiceRequestedNoVerifyWebhook');

const invoiceNumberGenerator = new InvoiceNumberGenerator();

/**
 * Custom webhook handler that bypasses signature verification for SDK v0.50.1
 * This is needed because the older SDK version doesn't support verifySignatureFn
 * like the newer versions used in the main saleor-apps.
 */
export default async function invoiceRequestedNoVerify(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    logger.info('Processing webhook without signature verification');

    if (req.method !== 'POST') {
      logger.warn('Invalid request method', { method: req.method });
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Extract Saleor headers
    const { event } = getSaleorHeaders(req.headers);
    const saleorApiUrl = normalizeSaleorApiUrl(req.headers[SALEOR_API_URL_HEADER] as string);
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

    logger.debug('Webhook headers extracted', {
      event,
      baseUrl,
      saleorApiUrl,
      hasContentLength: !!req.headers['content-length']
    });

    if (event !== 'invoice_requested') {
      logger.warn('Wrong event type', { receivedEvent: event, expectedEvent: 'invoice_requested' });
      return res.status(400).json({ error: 'Wrong event type' });
    }

    // Get raw body
    const rawBody = await getRawBody(req, {
      length: req.headers['content-length'],
      limit: '1mb',
      encoding: 'utf8'
    });

    logger.debug('Raw body received', {
      bodyLength: rawBody.length,
      bodyPreview: rawBody.toString().substring(0, 100) + '...'
    });

    // Parse payload
    let payload;
    try {
      const bodyStr = rawBody.toString();
      payload = JSON.parse(bodyStr);
    } catch (parseError) {
      logger.error('Failed to parse webhook payload', { error: parseError });
      return res.status(400).json({ error: 'Invalid JSON payload' });
    }

    // Handle both old and new payload formats
    // Old format: { event: { order: {...}, invoice: {...} } }
    // New format: { order: {...}, invoice: {...} }
    if (!payload.event && !payload.order) {
      logger.error('Missing order data in payload', { payload });
      return res.status(400).json({ error: 'Missing order data' });
    }

    // Get auth data without signature verification
    const authData = await saleorApp.apl.get(saleorApiUrl);
    if (!authData) {
      logger.error('App not registered for this Saleor instance', { saleorApiUrl });
      return res.status(401).json({ error: 'App not registered' });
    }

    logger.info('Authentication successful', {
      appId: authData.appId,
      saleorApiUrl: authData.saleorApiUrl
    });

    const order = payload.event?.order || payload.order;
    const orderId = order.id;

    logger.info('Processing invoice request', {
      orderId,
      orderNumber: order.number,
      invoiceId: payload.event?.invoice?.id || payload.invoice?.id
    });

    // Generate invoice name
    const invoiceName = invoiceNumberGenerator.generateFromOrder(
      order,
      InvoiceNumberGenerationStrategy.localizedDate("en-US")
    );

    logger.debug('Generated invoice name', { invoiceName });

    // Create GraphQL client
    const client = createGraphQLClient({
      saleorApiUrl,
      token: authData.token,
    });

    // Generate hashed filename
    const hashedInvoiceName = hashInvoiceFilename(invoiceName, orderId);
    const hashedInvoiceFileName = `${hashedInvoiceName}.pdf`;
    const tempPdfLocation = await resolveTempPdfFileLocation(hashedInvoiceFileName);

    logger.debug('Resolved PDF location', { tempPdfLocation });

    // Get app configuration
    let appConfigV2 = (await new GetAppConfigurationV2Service({
      saleorApiUrl,
      apiClient: client,
    }).getConfiguration()) ?? new AppConfigV2();

    // Get address configuration
    const address: AddressV2Shape | null =
      appConfigV2.getChannelsOverrides()[order.channel.slug] ??
      (await new ShopInfoFetcher(client)
        .fetchShopInfo()
        .then(shopInfoQueryToAddressShape));

    if (!address) {
      logger.warn('App not configured - no address found');
      return res.status(200).json({ message: 'App not configured' });
    }

    logger.debug('Using address configuration', {
      hasChannelOverride: !!appConfigV2.getChannelsOverrides()[order.channel.slug],
      channelSlug: order.channel.slug
    });

    // Generate the invoice PDF
    await new MicroinvoiceInvoiceGenerator().generate({
      order,
      invoiceNumber: invoiceName,
      filename: tempPdfLocation,
      companyAddressData: address,
    });

    logger.info('Invoice PDF generated successfully');

    // Upload the file
    const uploader = new SaleorInvoiceUploader(client);
    const uploadedFileUrl = await uploader.upload(
      tempPdfLocation,
      `${invoiceName}.pdf`
    );

    logger.info('Invoice uploaded to storage', { uploadedFileUrl });

    // Notify Saleor about the created invoice
    await new InvoiceCreateNotifier(client).notifyInvoiceCreated(
      orderId,
      invoiceName,
      uploadedFileUrl
    );

    logger.info('Saleor notified of invoice creation - Success');

    return res.status(200).json({
      success: true,
      invoiceName,
      uploadedFileUrl
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('Webhook processing error', { error, stack: errorStack });
    return res.status(500).json({
      error: 'Internal server error',
      message: errorMessage
    });
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};
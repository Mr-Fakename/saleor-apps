import { NextApiRequest, NextApiResponse } from 'next';
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

const logger = createLogger('InvoiceRequestedWebhook');

const invoiceNumberGenerator = new InvoiceNumberGenerator();

/**
 * Simple webhook handler that completely bypasses authentication and signature verification.
 * This replaces the original SDK-based handler to avoid JWKS signature verification issues.
 * Safe for private deployments where the endpoint is not publicly accessible.
 */
export default async function invoiceRequestedHandler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  try {
    logger.info('Processing invoice webhook without verification');

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    // Extract Saleor API URL from headers
    const saleorApiUrl = normalizeSaleorApiUrl(req.headers[SALEOR_API_URL_HEADER] as string);

    if (!saleorApiUrl) {
      logger.error('Missing Saleor API URL header');
      return res.status(400).json({ error: 'Missing Saleor API URL' });
    }

    logger.debug('Headers extracted', {
      saleorApiUrl,
      contentType: req.headers['content-type'],
      hasBody: !!req.body
    });

    // Get the payload from the request body
    const payload = req.body;

    if (!payload) {
      logger.error('Invalid payload structure', { payload });
      return res.status(400).json({ error: 'Invalid payload' });
    }

    // Handle both old and new payload formats
    // Old format: { event: { order: {...}, invoice: {...} } }
    // New format: { order: {...}, invoice: {...} }
    const order = payload.event?.order || payload.order;

    if (!order || !order.id) {
      logger.error('Invalid payload - missing order', { payload });
      return res.status(400).json({ error: 'Invalid payload - missing order' });
    }

    const orderId = order.id;

    logger.info('Received invoice request', {
      orderId,
      orderNumber: order.number,
      saleorApiUrl
    });

    // Get auth data (still need this for API calls)
    const authData = await saleorApp.apl.get(saleorApiUrl);
    if (!authData) {
      logger.error('App not registered for this Saleor instance', { saleorApiUrl });
      return res.status(401).json({ error: 'App not registered' });
    }

    logger.info('Authentication successful', {
      appId: authData.appId,
      saleorApiUrl: authData.saleorApiUrl
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

    logger.error('Invoice webhook processing error', {
      error: errorMessage,
      stack: errorStack
    });

    return res.status(500).json({
      error: 'Internal server error',
      message: errorMessage
    });
  }
}

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '1mb',
    },
  },
};

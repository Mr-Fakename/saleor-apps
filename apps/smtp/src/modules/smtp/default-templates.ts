import { MessageEventTypes } from "../event-handlers/message-event-types";
import {
  addresses,
  button,
  c,
  divider,
  greeting,
  heading,
  orderSummary,
  panel,
  text,
  wrapEmail,
} from "./email-design-system";

/**
 * Default MJML templates for every transactional email the SMTP app sends.
 *
 * All chrome (logo header, brand palette, card, footer, dark-mode, responsive
 * layout) comes from ../email-design-system.ts — these templates only declare
 * their unique content. That is the consolidation: one design system, applied
 * everywhere, so the emails look and feel like the Dess storefront.
 *
 * Handlebars variables are preserved exactly. Note the two field-casing worlds:
 * GraphQL webhook payloads use camelCase (order.lines, totalPrice.gross.amount),
 * while NOTIFY payloads (ORDER_FULFILLMENT_UPDATE, STAFF_ORDER_CONFIRMATION) use
 * snake_case — hence orderSummary({ snake }) / addresses({ snake }).
 */

// --- Orders (camelCase webhook payloads) -----------------------------------

const defaultOrderCreatedMjmlTemplate = wrapEmail({
  preheader: "Merci pour votre commande — nous la préparons.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Merci pour votre commande !"),
    text("Bonjour, nous avons bien reçu votre commande et la préparons avec soin. Voici le récapitulatif :"),
    orderSummary(),
    addresses(),
  ].join("\n"),
});

const defaultOrderConfirmedMjmlTemplate = wrapEmail({
  preheader: "Votre commande est confirmée.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Votre commande est confirmée"),
    text("Bonjour, votre commande est confirmée et entre en préparation. Voici le récapitulatif :"),
    orderSummary(),
    addresses(),
  ].join("\n"),
});

const defaultOrderFulfilledMjmlTemplate = wrapEmail({
  preheader: "Votre commande est en route.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Votre commande a été expédiée"),
    text("Bonne nouvelle — votre commande a été expédiée et arrive bientôt."),
    // trackingLinks is injected by the order-fulfilled webhook handler
    // (get-tracking-links.ts): [{ code, url }] per fulfillment with tracking.
    `        {{#if trackingLinks}}{{#if (gt trackingLinks.length 0)}}`,
    `        {{#each trackingLinks}}`,
    panel(
      `<p style="margin:0;color:${c.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;">Numéro de suivi</p>` +
        `<p style="margin:6px 0 0;color:${c.ink};font-weight:600;font-size:16px;">{{ this.code }}</p>`,
    ),
    // Triple-stash: the URL is built by getTrackingLinks (trusted), and
    // Handlebars escaping would mangle '=' into &#x3D; inside the href.
    button("{{{ this.url }}}", "Suivre mon colis"),
    `        {{/each}}`,
    `        {{/if}}{{/if}}`,
    orderSummary(),
    addresses(),
  ].join("\n"),
});

const defaultOrderFullyPaidMjmlTemplate = wrapEmail({
  preheader: "Paiement reçu — merci.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Paiement confirmé"),
    text("Merci, nous avons bien reçu votre paiement. Voici le récapitulatif de votre commande :"),
    orderSummary(),
    addresses(),
    `        {{#if downloadLinks}}{{#if (gt downloadLinks.length 0)}}`,
    divider(),
    text(`<strong style="color:${c.ink};">Vos téléchargements numériques</strong>`, "0 0 6px"),
    text("Cliquez sur chaque lien pour télécharger vos produits. Les liens expirent à la date indiquée."),
    `        {{#each downloadLinks}}`,
    panel(
      `<p style="margin:0 0 10px;color:${c.ink};font-weight:600;font-size:14px;">{{ this.productName }}{{#if this.variantName}} — {{ this.variantName }}{{/if}}</p>` +
        `<a href="{{ this.downloadUrl }}" style="display:inline-block;background:${c.accent};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:11px 24px;border-radius:10px;">Télécharger</a>` +
        `<p style="margin:10px 0 0;color:${c.muted};font-size:12px;">Expire le : {{ this.expiresAt }}</p>`,
    ),
    `        {{/each}}`,
    `        {{/if}}{{/if}}`,
  ].join("\n"),
});

const defaultOrderRefundedMjmlTemplate = wrapEmail({
  preheader: "Votre remboursement a été effectué.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Votre remboursement a été effectué"),
    text("Bonjour, votre remboursement a été traité. Selon votre banque, il peut prendre quelques jours ouvrés pour apparaître sur votre compte."),
    orderSummary(),
    addresses(),
  ].join("\n"),
});

const defaultOrderCancelledMjmlTemplate = wrapEmail({
  preheader: "Votre commande a été annulée.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Votre commande a été annulée"),
    text("Bonjour, votre commande a été annulée. Si un paiement a été effectué, il vous sera remboursé. Pour toute question, répondez simplement à cet e-mail."),
    orderSummary(),
    addresses(),
  ].join("\n"),
});

// --- Order (NOTIFY payload — snake_case) ------------------------------------

const defaultOrderFulfillmentUpdatedMjmlTemplate = wrapEmail({
  preheader: "Mise à jour de votre livraison.",
  body: [
    greeting("Commande {{ order.number }}"),
    heading("Mise à jour de votre livraison"),
    text("Bonjour, le suivi de votre commande a été mis à jour."),
    `        {{#if fulfillment.tracking_number}}`,
    panel(
      `<p style="margin:0;color:${c.muted};font-size:12px;text-transform:uppercase;letter-spacing:0.06em;">Numéro de suivi</p>` +
        `<p style="margin:6px 0 0;color:${c.ink};font-weight:600;font-size:16px;">{{ fulfillment.tracking_number }}</p>`,
    ),
    `        {{/if}}`,
    addresses({ snake: true }),
  ].join("\n"),
});

// --- Invoice / gift card ----------------------------------------------------

const defaultInvoiceSentMjmlTemplate = wrapEmail({
  preheader: "Votre facture est disponible.",
  body: [
    greeting("Facturation"),
    heading("Votre facture est disponible"),
    text("Bonjour, une nouvelle facture a été émise pour votre commande. Vous la trouverez en pièce jointe ou dans votre espace client."),
  ].join("\n"),
});

const defaultGiftCardSentMjmlTemplate = wrapEmail({
  preheader: "Une carte cadeau vous a été envoyée.",
  body: [
    greeting("Carte cadeau"),
    heading("Votre carte cadeau Dess"),
    text("Bonjour, une carte cadeau vous a été envoyée. Utilisez-la lors de votre prochaine commande sur notre boutique."),
    button("https://www.dess-equipement.com", "Découvrir la boutique"),
  ].join("\n"),
});

// --- Account (snake_case user payloads) -------------------------------------

const defaultAccountConfirmationMjmlTemplate = wrapEmail({
  preheader: "Activez votre compte Dess.",
  body: [
    greeting("Votre compte"),
    heading("Activez votre compte"),
    text("Bonjour {{ user.first_name }}, bienvenue chez Dess. Cliquez ci-dessous pour activer votre compte."),
    button("{{ confirm_url }}", "Activer mon compte"),
    text(`Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet e-mail.`, "12px 0 0"),
  ].join("\n"),
});

const defaultAccountPasswordResetMjmlTemplate = wrapEmail({
  preheader: "Réinitialisez votre mot de passe.",
  body: [
    greeting("Sécurité"),
    heading("Réinitialisation du mot de passe"),
    text("Bonjour {{ user.first_name }}, vous avez demandé à réinitialiser votre mot de passe. Cliquez ci-dessous pour en choisir un nouveau."),
    button("{{ reset_url }}", "Réinitialiser le mot de passe"),
    text(`Si vous n'avez pas demandé cette réinitialisation, ignorez cet e-mail — votre mot de passe reste inchangé.`, "12px 0 0"),
  ].join("\n"),
});

const defaultAccountChangeEmailRequestMjmlTemplate = wrapEmail({
  preheader: "Confirmez votre nouvelle adresse e-mail.",
  body: [
    greeting("Votre compte"),
    heading("Confirmez votre nouvelle adresse"),
    text("Bonjour {{ user.first_name }}, vous avez demandé à modifier votre adresse e-mail en <strong>{{ new_email }}</strong>. Cliquez ci-dessous pour confirmer."),
    button("{{ redirect_url }}", "Confirmer le changement"),
  ].join("\n"),
});

const defaultAccountChangeEmailConfirmationMjmlTemplate = wrapEmail({
  preheader: "Votre adresse e-mail a été modifiée.",
  body: [
    greeting("Votre compte"),
    heading("Adresse e-mail modifiée"),
    text("Bonjour {{ user.first_name }}, votre adresse e-mail a été modifiée avec succès."),
  ].join("\n"),
});

const defaultAccountDeleteMjmlTemplate = wrapEmail({
  preheader: "Confirmez la suppression de votre compte.",
  body: [
    greeting("Votre compte"),
    heading("Confirmer la suppression"),
    text("Bonjour {{ user.first_name }}, vous avez demandé la suppression de votre compte. Cliquez ci-dessous pour confirmer. Cette action est définitive."),
    button("{{ redirect_url }}", "Supprimer mon compte"),
  ].join("\n"),
});

const defaultAccountSetCustomerPasswordMjmlTemplate = wrapEmail({
  preheader: "Définissez votre mot de passe.",
  body: [
    greeting("Votre compte"),
    heading("Définissez votre mot de passe"),
    text("Bonjour {{ user.first_name }}, votre compte a été créé. Choisissez votre mot de passe pour commencer."),
    button("{{ password_set_url }}", "Définir mon mot de passe"),
  ].join("\n"),
});

const defaultAccountSetStaffPasswordMjmlTemplate = wrapEmail({
  preheader: "Définissez le mot de passe de votre compte.",
  body: [
    greeting("Équipe Dess"),
    heading("Définissez votre mot de passe"),
    text("Bonjour {{ user.first_name }}, votre compte équipe a été créé. Choisissez votre mot de passe pour accéder au tableau de bord."),
    button("{{ password_set_url }}", "Définir mon mot de passe"),
  ].join("\n"),
});

const defaultAccountStaffResetPasswordMjmlTemplate = wrapEmail({
  preheader: "Réinitialisation du mot de passe (équipe).",
  body: [
    greeting("Équipe Dess"),
    heading("Réinitialisation du mot de passe"),
    text("Bonjour {{ user.first_name }}, une réinitialisation du mot de passe a été demandée pour votre compte équipe. Cliquez ci-dessous pour continuer."),
    button("{{ reset_url }}", "Réinitialiser le mot de passe"),
  ].join("\n"),
});

// --- CSV exports (staff) ----------------------------------------------------

const defaultCsvExportSuccessMjmlTemplate = wrapEmail({
  preheader: "Votre export CSV est prêt.",
  body: [
    greeting("Export"),
    heading("Votre export CSV est prêt"),
    text("Votre export CSV est terminé. Cliquez ci-dessous pour le télécharger."),
    button("{{ csv_link }}", "Télécharger le CSV"),
  ].join("\n"),
});

const defaultCsvExportFailedMjmlTemplate = wrapEmail({
  preheader: "Votre export CSV a échoué.",
  body: [
    greeting("Export"),
    heading("Échec de l'export CSV"),
    text("Malheureusement, votre export CSV a échoué. Veuillez réessayer ou contacter le support si le problème persiste."),
  ].join("\n"),
});

// --- Withdrawal / right of retraction (FR — legal copy preserved) -----------

const defaultWithdrawalRequestedCustomerMjmlTemplate = wrapEmail({
  preheader: "Confirmation de votre demande de rétractation.",
  body: [
    greeting("Rétractation"),
    heading("Confirmation de votre demande de rétractation"),
    text("Bonjour {{ customer_first_name }},"),
    text("Nous avons bien reçu votre demande de rétractation concernant la commande n°{{ order_number }} passée le {{ order_created }}."),
    panel(
      `<p style="margin:0;color:${c.body};font-size:14px;line-height:1.7;"><strong style="color:${c.ink};">Référence de votre demande :</strong> {{ reference }}<br/>` +
        `<strong style="color:${c.ink};">Date de la demande :</strong> {{ requested_at }}</p>`,
    ),
    `        {{#if reason}}`,
    text("<strong>Motif indiqué :</strong> {{ reason }}"),
    `        {{/if}}`,
    text(`<strong style="color:${c.ink};">Prochaines étapes</strong>`, "12px 0 6px"),
    text("Vous disposez de 14 jours à compter de la réception de votre commande pour nous retourner les produits. Veuillez les renvoyer <strong>à l'état neuf, dans leur emballage d'origine</strong>, à l'adresse qui vous sera communiquée dans un email de suivi."),
    text("Le remboursement sera effectué manuellement après réception et contrôle des articles. Nous nous réservons le droit de refuser le remboursement ou d'appliquer un remboursement partiel si les produits présentent des signes d'utilisation, de dommage ou si leur emballage d'origine est manquant."),
    text("Conformément au droit de rétractation (articles L.221-18 et suivants du Code de la consommation), aucune justification n'est requise. Cet email constitue la confirmation de la prise en compte de votre demande sur un support durable."),
  ].join("\n"),
});

const defaultWithdrawalRequestedStaffMjmlTemplate = wrapEmail({
  preheader: "Nouvelle demande de rétractation à traiter.",
  body: [
    greeting("Rétractation — équipe"),
    heading("Nouvelle demande de rétractation"),
    text("Une demande de rétractation vient d'être enregistrée et doit être traitée manuellement."),
    panel(
      `<p style="margin:0;color:${c.body};font-size:14px;line-height:1.7;">` +
        `<strong style="color:${c.ink};">Référence :</strong> {{ reference }}<br/>` +
        `<strong style="color:${c.ink};">Commande :</strong> n°{{ order_number }} ({{ order_total }} {{ order_currency }})<br/>` +
        `<strong style="color:${c.ink};">Commande passée le :</strong> {{ order_created }}<br/>` +
        `<strong style="color:${c.ink};">Client :</strong> {{ customer_first_name }} {{ customer_last_name }} &lt;{{ recipient_email }}&gt;<br/>` +
        `<strong style="color:${c.ink};">Demandé le :</strong> {{ requested_at }}</p>`,
    ),
    `        {{#if reason}}`,
    text("<strong>Motif indiqué par le client :</strong><br/>{{ reason }}"),
    `        {{/if}}`,
    text(`La demande est stampée dans les métadonnées de la commande (clé <code>withdrawal.requestedAt</code>). Traitez le remboursement depuis le Dashboard après réception et contrôle des produits.`),
  ].join("\n"),
});

// --- Staff order confirmation (NOTIFY payload — snake_case) ------------------

const defaultStaffOrderConfirmationMjmlTemplate = wrapEmail({
  preheader: "Nouvelle commande reçue.",
  body: [
    greeting("Nouvelle commande"),
    heading("Nouvelle commande reçue"),
    text("La commande n°{{ order.number }} a été passée par {{ order.email }}."),
    addresses({ snake: true }),
  ].join("\n"),
});

export const defaultMjmlTemplates: Record<MessageEventTypes, string> = {
  ACCOUNT_CHANGE_EMAIL_CONFIRM: defaultAccountChangeEmailConfirmationMjmlTemplate,
  ACCOUNT_CHANGE_EMAIL_REQUEST: defaultAccountChangeEmailRequestMjmlTemplate,
  ACCOUNT_CONFIRMATION: defaultAccountConfirmationMjmlTemplate,
  ACCOUNT_DELETE: defaultAccountDeleteMjmlTemplate,
  ACCOUNT_PASSWORD_RESET: defaultAccountPasswordResetMjmlTemplate,
  ACCOUNT_SET_CUSTOMER_PASSWORD: defaultAccountSetCustomerPasswordMjmlTemplate,
  ACCOUNT_SET_STAFF_PASSWORD: defaultAccountSetStaffPasswordMjmlTemplate,
  ACCOUNT_STAFF_RESET_PASSWORD: defaultAccountStaffResetPasswordMjmlTemplate,
  CSV_EXPORT_SUCCESS: defaultCsvExportSuccessMjmlTemplate,
  CSV_EXPORT_FAILED: defaultCsvExportFailedMjmlTemplate,
  GIFT_CARD_SENT: defaultGiftCardSentMjmlTemplate,
  INVOICE_SENT: defaultInvoiceSentMjmlTemplate,
  ORDER_CANCELLED: defaultOrderCancelledMjmlTemplate,
  ORDER_CONFIRMED: defaultOrderConfirmedMjmlTemplate,
  ORDER_CREATED: defaultOrderCreatedMjmlTemplate,
  ORDER_FULFILLED: defaultOrderFulfilledMjmlTemplate,
  ORDER_FULFILLMENT_UPDATE: defaultOrderFulfillmentUpdatedMjmlTemplate,
  ORDER_FULLY_PAID: defaultOrderFullyPaidMjmlTemplate,
  ORDER_REFUNDED: defaultOrderRefundedMjmlTemplate,
  STAFF_ORDER_CONFIRMATION: defaultStaffOrderConfirmationMjmlTemplate,
  WITHDRAWAL_REQUESTED_CUSTOMER: defaultWithdrawalRequestedCustomerMjmlTemplate,
  WITHDRAWAL_REQUESTED_STAFF: defaultWithdrawalRequestedStaffMjmlTemplate,
};

export const defaultMjmlSubjectTemplates: Record<MessageEventTypes, string> = {
  ACCOUNT_CHANGE_EMAIL_CONFIRM: "Changement d'adresse e-mail confirmé",
  ACCOUNT_CHANGE_EMAIL_REQUEST: "Confirmez votre nouvelle adresse e-mail",
  ACCOUNT_CONFIRMATION: "Activez votre compte Dess",
  ACCOUNT_DELETE: "Confirmez la suppression de votre compte",
  ACCOUNT_PASSWORD_RESET: "Réinitialisation de votre mot de passe",
  ACCOUNT_SET_CUSTOMER_PASSWORD: "Définissez votre mot de passe",
  ACCOUNT_SET_STAFF_PASSWORD: "Définissez le mot de passe de votre compte équipe",
  ACCOUNT_STAFF_RESET_PASSWORD: "Réinitialisation du mot de passe (équipe)",
  CSV_EXPORT_SUCCESS: "Votre export CSV est prêt",
  CSV_EXPORT_FAILED: "Échec de votre export CSV",
  GIFT_CARD_SENT: "Votre carte cadeau Dess",
  INVOICE_SENT: "Votre facture est disponible",
  ORDER_CANCELLED: "Votre commande {{ order.number }} a été annulée",
  ORDER_CONFIRMED: "Votre commande {{ order.number }} est confirmée",
  ORDER_CREATED: "Merci pour votre commande {{ order.number }}",
  ORDER_FULFILLED: "Votre commande {{ order.number }} a été expédiée",
  ORDER_FULFILLMENT_UPDATE: "Mise à jour de votre commande {{ order.number }}",
  ORDER_FULLY_PAID: "Paiement confirmé — commande {{ order.number }}",
  ORDER_REFUNDED: "Votre remboursement — commande {{ order.number }}",
  STAFF_ORDER_CONFIRMATION: "Nouvelle commande {{ order.number }}",
  WITHDRAWAL_REQUESTED_CUSTOMER: "Confirmation de votre demande de rétractation - Commande n°{{ order_number }}",
  WITHDRAWAL_REQUESTED_STAFF: "[Rétractation] Demande pour commande n°{{ order_number }} ({{ reference }})",
};

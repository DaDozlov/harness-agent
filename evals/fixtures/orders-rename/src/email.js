/** Order mails in the languages we answer in. */
const TEMPLATES = {
  en: {
    subject: 'Your order #{id}',
    body: ['Dear {name},', '', 'thank you for your order #{id}.', 'We will send it within two working days.', '', 'Kind regards,', 'The shop team'],
  },
  de: {
    subject: 'Ihre Bestellung #{id}',
    body: ['Guten Tag {name},', '', 'vielen Dank für Ihre Bestellung #{id}.', 'Wir versenden sie innerhalb von zwei Werktagen.', '', 'Freundliche Grüße', 'Ihr Shop-Team'],
  },
  fr: {
    subject: 'Votre commande #{id}',
    body: ['Bonjour {name},', '', 'merci pour votre commande #{id}.', 'Nous l\'expédions sous deux jours ouvrés.', '', 'Cordialement,', 'L\'équipe de la boutique'],
  },
};

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

/** The confirmation mail for an order: `{ subject, text }`. */
export function confirmationMail(order, language = 'en') {
  const template = TEMPLATES[language] ?? TEMPLATES.en;
  const values = { id: order.id, name: order.customerName };
  return { subject: fill(template.subject, values), text: template.body.map((line) => fill(line, values)).join('\n') };
}

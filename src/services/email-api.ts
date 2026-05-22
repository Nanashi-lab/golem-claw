// Sends plain-text emails through Resend with optional idempotency protection.
import type { Secret } from '@golemcloud/golem-ts-sdk';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

// Sends one email and returns the provider message id.
export async function sendEmailViaResend(
  apiKey: Secret<string>,
  fromEmail: Secret<string>,
  to: string,
  subject: string,
  text: string,
  idempotencyKey?: string
): Promise<string> {
  const response = await fetch(RESEND_EMAILS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey.get()}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': safeIdempotencyKey(idempotencyKey) } : {}),
    },
    body: JSON.stringify({
      from: fromEmail.get(),
      to: [to],
      subject,
      text,
      html: `<pre style="white-space: pre-wrap; font-family: sans-serif;">${escapeHtml(text)}</pre>`,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Resend send failed: ${response.status} ${body}`);
  }

  const parsed = JSON.parse(body) as { id?: string };
  return parsed.id ?? 'unknown';
}

// Escapes user text before embedding it into the HTML fallback body.
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
}

// Normalizes arbitrary idempotency keys into the provider's accepted character set.
function safeIdempotencyKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 256);
}

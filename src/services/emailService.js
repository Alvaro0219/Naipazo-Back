import { env } from '../config/env.js';

// Envío de emails transaccionales con Resend (API HTTP, sin librerías). Sin EMAIL_API_KEY el email
// se escribe en la consola: así se prueba en desarrollo sin mandar nada.
const RESEND_URL = 'https://api.resend.com/emails';

let testOutbox = null;

/** Solo tests: captura los emails en lugar de enviarlos. */
export function setTestOutbox(list) {
  testOutbox = list;
}

export async function sendEmail({ to, subject, text, html }) {
  if (testOutbox) {
    testOutbox.push({ to, subject, text, html });
    return;
  }
  if (!env.emailApiKey) {
    console.info(`\n[email] Para: ${to}\n[email] Asunto: ${subject}\n${text}\n`);
    return;
  }
  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.emailApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject, text, html })
  });
  if (!res.ok) throw new Error(`El proveedor de email respondió ${res.status}: ${await res.text()}`);
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function layout({ title, intro, buttonLabel, link, outro }) {
  const text = `${title}\n\n${intro}\n\n${link}\n\n${outro}\n\n— Naipazo`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2937">
  <h2 style="color:#14532d">${escapeHtml(title)}</h2>
  <p>${escapeHtml(intro)}</p>
  <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#15803d;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">${escapeHtml(buttonLabel)}</a></p>
  <p style="font-size:13px;color:#6b7280">Si el botón no funciona, copiá este enlace en el navegador:<br>${escapeHtml(link)}</p>
  <p style="font-size:13px;color:#6b7280">${escapeHtml(outro)}</p>
  <p style="font-size:12px;color:#9ca3af">Naipazo: las fichas son virtuales, no tienen valor monetario y no son canjeables.</p>
</div>`;
  return { text, html };
}

export function sendVerificationEmail(user, token) {
  const link = `${env.appUrl}/verificar-email?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Verificá tu email en Naipazo',
    ...layout({
      title: `¡Hola, ${user.username}!`,
      intro: 'Confirmá tu email para empezar a recibir tus fichas diarias.',
      buttonLabel: 'Verificar email',
      link,
      outro: 'El enlace vence en 24 horas. Si no creaste una cuenta en Naipazo, ignorá este email.'
    })
  });
}

export function sendPasswordResetEmail(user, token) {
  const link = `${env.appUrl}/restablecer?token=${token}`;
  return sendEmail({
    to: user.email,
    subject: 'Cambiá tu contraseña de Naipazo',
    ...layout({
      title: `Hola, ${user.username}`,
      intro: 'Pediste cambiar tu contraseña. Tocá el botón para elegir una nueva.',
      buttonLabel: 'Elegir contraseña nueva',
      link,
      outro: 'El enlace vence en 1 hora y sirve una sola vez. Si no lo pediste, ignorá este email: tu contraseña no cambia.'
    })
  });
}

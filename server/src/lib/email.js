import { env } from '../config/env.js';

// Service abstraction: every module calls sendEmail() and never talks to a
// transport directly. The transport is picked once, here, from
// EMAIL_TRANSPORT. This satisfies requirement 18 ("if an external service
// is required but its final provider is unspecified, create a clean
// service abstraction and document where its credentials must be added") —
// the SRS leaves the email provider unspecified (see 2.7 "depends on
// services that provide confirmation through email").
//
// To use real SMTP: set EMAIL_TRANSPORT=smtp and SMTP_HOST / SMTP_PORT /
// SMTP_USER / SMTP_PASS in .env, then implement sendViaSmtp() below with
// your SMTP library of choice. Nothing else in the codebase needs to change.

async function sendViaConsole({ to, subject, text }) {
  // Development transport: prints the email instead of sending it, so the
  // full registration/OTP flow works with zero external services.
  console.log('\n----- [dev email transport] -----');
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('----------------------------------\n');
  return { delivered: true, transport: 'console' };
}

async function sendViaSmtp({ to, subject, text }) {
  throw new Error(
    'SMTP transport selected (EMAIL_TRANSPORT=smtp) but not yet implemented. ' +
      'Add your SMTP client here using SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS from env.js.'
  );
}

export async function sendEmail({ to, subject, text }) {
  const transport = env.email.transport;
  if (transport === 'smtp') return sendViaSmtp({ to, subject, text });
  return sendViaConsole({ to, subject, text });
}

export async function sendOtpEmail(to, otp, purpose) {
  const label = purpose === 'password_reset' ? 'password reset' : 'registration';
  return sendEmail({
    to,
    subject: `V-ACCESS ${label} code`,
    text: `Your V-ACCESS verification code is ${otp}. It expires in ${env.otpTtlMinutes} minutes. If you did not request this, ignore this email.`,
  });
}

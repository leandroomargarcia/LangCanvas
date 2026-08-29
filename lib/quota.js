// Owner / operator accounts skip daily AI quotas.

export const UNLIMITED_EMAILS = ['leomniga@gmail.com'];

export function isUnlimitedEmail(email) {
  return UNLIMITED_EMAILS.includes(String(email || '').trim().toLowerCase());
}

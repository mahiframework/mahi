import type { TotpAlgorithm } from "./totp.js";

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Returned as a STRING, never as a QR image. Rendering is a presentation
 * concern, a QR encoder is a real dependency for something the client
 * may well do itself, and the string is also the "enter this manually"
 * fallback every authenticator app offers. An app that wants a PNG
 * encodes this with whatever library it already has.
 *
 * Format is Google's de-facto `otpauth://totp/{issuer}:{account}?...`,
 * which is not an RFC but is what every app implements.
 */
export interface OtpauthUriOptions {
  /** Base32 secret. */
  secret: string;
  /** The account this identifies, conventionally an email address. */
  account: string;
  /** Your application's name, shown as the credential's issuer. */
  issuer?: string;
  digits?: number;
  period?: number;
  algorithm?: TotpAlgorithm;
}

/**
 * Build the enrollment URI.
 *
 * The issuer appears TWICE by design: once as the label prefix
 * (`issuer:account`) and once as the `issuer` query parameter. The
 * prefix is what older apps display; the parameter is what newer ones
 * read. Google's Key URI Format spec recommends emitting both, and apps
 * that read the parameter use it to deduplicate against the prefix.
 *
 * `digits`, `period` and `algorithm` are only emitted when they differ
 * from the universal defaults (6 / 30 / SHA1). Several authenticator
 * apps mis-parse a URI carrying an explicit `algorithm=SHA1` — and some
 * ignore the parameter entirely — so the shortest URI that describes the
 * default configuration is also the most interoperable one.
 */
export function otpauthUri(options: OtpauthUriOptions): string {
  const { secret, account, issuer, digits, period, algorithm } = options;

  // `encodeURIComponent` encodes `:` and `@`, which is what we want in
  // the label: an account containing either would otherwise break the
  // `issuer:account` split.
  const label =
    issuer === undefined || issuer === ""
      ? encodeURIComponent(account)
      : `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;

  const parameters = new URLSearchParams({ secret });

  if (issuer !== undefined && issuer !== "") {
    parameters.set("issuer", issuer);
  }

  if (algorithm !== undefined && algorithm !== "SHA1") {
    parameters.set("algorithm", algorithm);
  }

  if (digits !== undefined && digits !== 6) {
    parameters.set("digits", String(digits));
  }

  if (period !== undefined && period !== 30) {
    parameters.set("period", String(period));
  }

  return `otpauth://totp/${label}?${parameters.toString()}`;
}

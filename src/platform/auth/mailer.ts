// Transactional email.
//
// Deliberately no SMTP dependency: the two messages this product sends —
// verify your address, and you have been invited — are plain HTTP calls to a
// provider. Adding nodemailer and a connection pool to send two emails would be
// more moving parts than the job needs.
//
// The transport is chosen by configuration, and production fails closed: if
// verification is required and no transport is configured, sign-up refuses
// rather than silently creating accounts nobody can confirm.
import { safeErrorMessage } from "../audit/redact";

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. Every client renders it, and it cannot carry a tracking pixel. */
  text: string;
}

export interface MailTransport {
  readonly id: string;
  readonly deliversForReal: boolean;
  send(message: MailMessage): Promise<void>;
}

/**
 * Development transport: prints the message, including the link.
 *
 * The link is the whole point — a developer needs to click it. This is why the
 * transport is never permitted in production, where printing a verification
 * link into the log would hand account access to anyone reading logs.
 */
export class ConsoleTransport implements MailTransport {
  readonly id = "console";
  readonly deliversForReal = false;
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);

    console.log(`\n[email → ${message.to}] ${message.subject}\n${message.text}\n`);
  }
}

/** Resend's HTTP API. Any provider with a JSON send endpoint fits the same shape. */
export class ResendTransport implements MailTransport {
  readonly id = "resend";
  readonly deliversForReal = true;

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: MailMessage): Promise<void> {
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      // The provider's body can echo the recipient and the API key prefix, so
      // it is never surfaced verbatim.
      throw new Error(`Email provider responded ${response.status}.`);
    }
  }
}

let transport: MailTransport | null = null;

export function getMailTransport(): MailTransport {
  if (transport) return transport;

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.MAIL_FROM?.trim();

  if (apiKey && from) {
    transport = new ResendTransport(apiKey, from);
    return transport;
  }

  const appEnv = (process.env.APP_ENV ?? "").trim().toLowerCase();
  const isProduction =
    appEnv === "production" || (appEnv === "" && process.env.NODE_ENV === "production");

  if (isProduction) {
    // Fail closed. A production deployment that cannot send email must not
    // print verification links into its logs, and must not quietly create
    // accounts that can never be confirmed.
    throw new Error(
      "No email transport is configured. Set RESEND_API_KEY and MAIL_FROM, or set " +
        "REQUIRE_EMAIL_VERIFICATION=0 to accept unverified sign-ups.",
    );
  }

  transport = new ConsoleTransport();
  return transport;
}

/** Test seam. */
export function setMailTransport(next: MailTransport | null): void {
  transport = next;
}

/**
 * Whether a new account must confirm its address before signing in.
 *
 * On by default. An analytics product that accepts any typed address will
 * happily send someone else's revenue to a typo.
 */
export function emailVerificationRequired(): boolean {
  const raw = (process.env.REQUIRE_EMAIL_VERIFICATION ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}

export function verificationMessage(
  email: string,
  url: string,
  lang: "ar" | "en" = "ar",
): MailMessage {
  const ar = lang === "ar";
  return {
    to: email,
    subject: ar ? "أكّد بريدك الإلكتروني — InsightOS" : "Confirm your email — InsightOS",
    text: ar
      ? [
          "أهلًا،",
          "",
          "اضغط الرابط ده عشان تأكّد بريدك وتكمّل إنشاء الحساب:",
          url,
          "",
          "الرابط صالح لمدة ساعة واحدة.",
          "لو مش انت اللي طلبت ده، تجاهل الرسالة — مفيش حساب هيتفعّل.",
        ].join("\n")
      : [
          "Hello,",
          "",
          "Confirm your email address to finish creating your account:",
          url,
          "",
          "This link is valid for one hour.",
          "If you did not request this, ignore this message — no account will be activated.",
        ].join("\n"),
  };
}

export function invitationMessage(
  email: string,
  workspaceName: string,
  url: string,
  lang: "ar" | "en" = "ar",
): MailMessage {
  const ar = lang === "ar";
  return {
    to: email,
    subject: ar
      ? `دعوة للانضمام إلى ${workspaceName}`
      : `You have been invited to ${workspaceName}`,
    text: ar
      ? [
          `اتدعيت للانضمام إلى مساحة العمل «${workspaceName}» على InsightOS.`,
          "",
          url,
          "",
          "الدعوة صالحة ١٤ يوم، ولازم تقبلها بنفس البريد ده.",
        ].join("\n")
      : [
          `You have been invited to the workspace "${workspaceName}" on InsightOS.`,
          "",
          url,
          "",
          "This invitation is valid for 14 days and must be accepted with this address.",
        ].join("\n"),
  };
}

/**
 * Sends without letting a delivery failure break the action that triggered it.
 *
 * Returns whether it went out, so a caller that must know — sign-up — can tell
 * the user, while a caller that need not — an invitation — carries on and
 * offers the link to copy instead.
 */
export async function trySend(message: MailMessage): Promise<{ sent: boolean; error?: string }> {
  try {
    await getMailTransport().send(message);
    return { sent: true };
  } catch (error) {
    return { sent: false, error: safeErrorMessage(error, 200) };
  }
}

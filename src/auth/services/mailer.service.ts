import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

export interface MailTransport {
  send(options: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void>;
}

class ConsoleTransport implements MailTransport {
  private readonly logger = new Logger('MailerService:Console');

  async send(options: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    this.logger.log(
      `[no-op mail] to=${options.to} subject="${options.subject}"\n${options.text}`,
    );
  }
}

class SmtpTransport implements MailTransport {
  private readonly logger = new Logger('MailerService:Smtp');

  constructor(
    private readonly transporter: Transporter,
    private readonly from: string,
  ) {}

  async send(options: {
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        text: options.text,
        html: options.html,
      });
    } catch (error) {
      this.logger.error(
        `Failed to send email to ${options.to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}

@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transport: MailTransport;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ||
      'http://localhost:3000';

    const nodeEnv = this.configService.get<string>('NODE_ENV');
    const mailHost = this.configService.get<string>('MAIL_HOST');

    if (nodeEnv === 'test' || !mailHost) {
      this.logger.log(
        'MailerService using console/no-op transport (MAIL_HOST not set or NODE_ENV=test)',
      );
      this.transport = new ConsoleTransport();
    } else {
      const port = Number(this.configService.get<string>('MAIL_PORT') ?? 587);
      const secure =
        this.configService.get<string>('MAIL_SECURE') === 'true' || port === 465;
      const user = this.configService.get<string>('MAIL_USER');
      const pass = this.configService.get<string>('MAIL_PASSWORD');
      const from =
        this.configService.get<string>('MAIL_FROM') ||
        'no-reply@lyricsflip.local';

      const transporter = nodemailer.createTransport({
        host: mailHost,
        port,
        secure,
        auth: user && pass ? { user, pass } : undefined,
      });

      this.transport = new SmtpTransport(transporter, from);
      this.logger.log(`MailerService using SMTP transport (${mailHost}:${port})`);
    }
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/verify-email?token=${encodeURIComponent(
      token,
    )}`;
    const subject = 'Verify your Lyricsflip email address';
    const text = `Welcome to Lyricsflip!\n\nPlease verify your email address by visiting the link below:\n\n${link}\n\nIf you did not create an account, you can safely ignore this email.`;
    const html = `<p>Welcome to Lyricsflip!</p><p>Please verify your email address by clicking the link below:</p><p><a href="${link}">Verify email</a></p><p>If you did not create an account, you can safely ignore this email.</p>`;

    await this.transport.send({ to, subject, text, html });
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendUrl}/reset-password?token=${encodeURIComponent(
      token,
    )}`;
    const subject = 'Reset your Lyricsflip password';
    const text = `We received a request to reset your Lyricsflip password.\n\nReset your password by visiting the link below:\n\n${link}\n\nIf you did not request a password reset, you can safely ignore this email.`;
    const html = `<p>We received a request to reset your Lyricsflip password.</p><p><a href="${link}">Reset password</a></p><p>If you did not request a password reset, you can safely ignore this email.</p>`;

    await this.transport.send({ to, subject, text, html });
  }
}
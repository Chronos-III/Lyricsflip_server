import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { Repository } from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  EmailToken,
  EmailTokenPurpose,
} from '../entities/email-token.entity';
import { MailerService } from './mailer.service';

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    @InjectRepository(EmailToken)
    private readonly emailTokenRepository: Repository<EmailToken>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly mailerService: MailerService,
  ) {}

  /**
   * Issues a new single-use email verification token for the given user.
   * Only the SHA-256 hash of the token is persisted; the raw token is emailed.
   */
  async issue(user: User): Promise<void> {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);

    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);

    const token = this.emailTokenRepository.create({
      userId: user.id,
      tokenHash,
      purpose: EmailTokenPurpose.VERIFY_EMAIL,
      expiresAt,
      usedAt: null,
    });

    await this.emailTokenRepository.save(token);

    await this.mailerService.sendVerificationEmail(user.email, rawToken);

    this.logger.debug(`Issued email verification token for user ${user.id}`);
  }

  /**
   * Consumes a raw verification token. Marks it used and sets
   * `user.emailVerifiedAt`. Throws BadRequestException if the token is
   * invalid, expired, or has already been used.
   */
  async consume(rawToken: string): Promise<User> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new BadRequestException('Invalid verification token');
    }

    const tokenHash = this.hashToken(rawToken);

    const token = await this.emailTokenRepository.findOne({
      where: {
        tokenHash,
        purpose: EmailTokenPurpose.VERIFY_EMAIL,
      },
      relations: ['user'],
    });

    if (!token) {
      throw new BadRequestException('Invalid verification token');
    }

    if (token.usedAt) {
      throw new BadRequestException('Verification token has already been used');
    }

    if (token.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('Verification token has expired');
    }

    const user =
      token.user ??
      (await this.userRepository.findOne({ where: { id: token.userId } }));

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Mark token as used (single use).
    token.usedAt = new Date();
    await this.emailTokenRepository.save(token);

    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date();
      await this.userRepository.save(user);
    }

    this.logger.debug(`Verified email for user ${user.id}`);

    return user;
  }

  private hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
  }
}
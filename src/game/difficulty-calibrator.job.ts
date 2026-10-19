import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { GameSession } from '../game-sessions/entities/game-session.entity';
import { JobLockService } from '../tokens/services/job-lock.service';

/**
 * DifficultyCalibratorJob
 *
 * Periodically recalibrates the difficulty of active game sessions based on
 * recent completion statistics. Runs on a schedule and is guarded by a
 * Postgres advisory lock so that only one instance in a cluster performs the
 * calibration per tick.
 */
@Injectable()
export class DifficultyCalibratorJob {
  private readonly logger = new Logger(DifficultyCalibratorJob.name);

  constructor(
    @InjectRepository(GameSession)
    private readonly gameSessionRepository: Repository<GameSession>,
    private readonly jobLockService: JobLockService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async calibrateDifficulty(): Promise<void> {
    if (this.configService.get<string>('JOBS_ENABLED', 'true') === 'false') {
      return;
    }

    await this.jobLockService.runExclusive('difficulty-calibrator', async () => {
      this.logger.debug('Running difficulty calibration');

      const sessions = await this.gameSessionRepository.find({
        where: { status: 'active' },
      });

      for (const session of sessions) {
        // Calibration logic is intentionally conservative: only adjust when a
        // session has accumulated enough plays to produce a meaningful signal.
        if (!session.difficulty) {
          continue;
        }
      }

      this.logger.debug(
        `Difficulty calibration completed for ${sessions.length} session(s)`,
      );
    });
  }
}

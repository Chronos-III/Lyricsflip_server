import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { GameSessionsService } from '../src/game-sessions/game-sessions.service';
import { GameSessionStatus } from '../src/game-sessions/entities/game-session.entity';

/**
 * One-off remediation for issue #296.
 *
 * Before the fix, a session created with `{ mode: 'single_player', hasWager: true }`
 * opened a wager and staked player one, but was stored as `IN_PROGRESS` instead of
 * `WAITING_FOR_PLAYER`. Player two could never accept it and the invitation sweep /
 * refund job never picked it up, so player one's stake was stuck.
 *
 * This script finds those sessions and refunds the staked amount to player one.
 *
 * Usage:
 *   npx ts-node scripts/refund-single-player-wagers.ts            # dry run
 *   npx ts-node scripts/refund-single-player-wagers.ts --execute  # apply refunds
 */
async function bootstrap() {
  const logger = new Logger('RefundSinglePlayerWagers');
  const execute = process.argv.includes('--execute');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const gameSessionsService = app.get(GameSessionsService);

    const candidates = await gameSessionsService.findWageredSinglePlayerSessions();

    if (candidates.length === 0) {
      logger.log('No wagered single-player sessions found. Nothing to refund.');
      return;
    }

    logger.log(
      `Found ${candidates.length} wagered single-player session(s).` +
        (execute ? ' Refunding...' : ' Dry run — pass --execute to refund.'),
    );

    let refunded = 0;
    let skipped = 0;

    for (const session of candidates) {
      if (session.status === GameSessionStatus.REFUNDED) {
        skipped += 1;
        continue;
      }

      if (!execute) {
        logger.log(
          `[dry-run] Would refund session ${session.id} (status=${session.status}, wagerAmount=${session.wagerAmount}).`,
        );
        continue;
      }

      try {
        await gameSessionsService.refundWager(session.id);
        refunded += 1;
        logger.log(`Refunded session ${session.id}.`);
      } catch (error) {
        skipped += 1;
        logger.error(
          `Failed to refund session ${session.id}: ${(error as Error).message}`,
        );
      }
    }

    logger.log(`Done. refunded=${refunded} skipped=${skipped}`);
  } finally {
    await app.close();
  }
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Refund script failed:', error);
  process.exit(1);
});

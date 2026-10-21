import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserLevel } from '../users/entities/user.entity';

export interface XpResult {
  /** Updated total XP. */
  xp: number;
  /** Numeric level (1–5). */
  level: number;
  /** Human-readable level title. */
  levelTitle: UserLevel;
}

/**
 * Canonical XP curve and title list.
 *
 * This is the single source of truth for the level system. Ordered
 * thresholds — first match wins. Numeric `level` maps 1-to-1 to the
 * position in this array (index + 1).
 */
export const LEVEL_THRESHOLDS: ReadonlyArray<{
  min: number;
  max: number;
  level: number;
  levelTitle: UserLevel;
}> = [
  { min: 0,    max: 99,       level: 1, levelTitle: UserLevel.GOSSIP_ROOKIE  },
  { min: 100,  max: 299,      level: 2, levelTitle: UserLevel.WORD_WHISPERER },
  { min: 300,  max: 599,      level: 3, levelTitle: UserLevel.LYRIC_SNIPER   },
  { min: 600,  max: 999,      level: 4, levelTitle: UserLevel.BAR_GENIUS     },
  { min: 1000, max: Infinity, level: 5, levelTitle: UserLevel.GOSSIP_GURU    },
];

/** XP awarded per correct guess — the single XP-award constant. */
export const XP_PER_CORRECT_GUESS = 10;

/**
 * Pure: return the numeric level (1–5) and its human-readable title for a
 * given XP total.
 */
export function getLevelFromXp(xp: number): {
  level: number;
  levelTitle: UserLevel;
} {
  const threshold =
    LEVEL_THRESHOLDS.find((t) => xp >= t.min && xp <= t.max) ??
    LEVEL_THRESHOLDS[0];

  return { level: threshold.level, levelTitle: threshold.levelTitle };
}

/**
 * Pure: add XP for a number of correct guesses and return the updated totals.
 *
 * @param currentXp      - The user's current total XP.
 * @param correctGuesses - How many correct guesses to award (default 1).
 * @param xpPerGuess     - XP per correct guess (default XP_PER_CORRECT_GUESS).
 */
export function calculateXpGain(
  currentXp: number,
  correctGuesses = 1,
  xpPerGuess = XP_PER_CORRECT_GUESS,
): XpResult {
  const newXp = currentXp + correctGuesses * xpPerGuess;
  const { level, levelTitle } = getLevelFromXp(newXp);
  return { xp: newXp, level, levelTitle };
}

@Injectable()
export class XpLevelService {
  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  // -------------------------------------------------------------------------
  // Pure helpers (no DB I/O — safe to call in unit tests without a repo)
  // -------------------------------------------------------------------------

  /** Return the numeric level (1–5) and its human-readable title for XP. */
  getLevelFromXp(xp: number): { level: number; levelTitle: UserLevel } {
    return getLevelFromXp(xp);
  }

  /** Add XP for a number of correct guesses and return the updated totals. */
  calculateXpGain(
    currentXp: number,
    correctGuesses = 1,
    xpPerGuess = XP_PER_CORRECT_GUESS,
  ): XpResult {
    return calculateXpGain(currentXp, correctGuesses, xpPerGuess);
  }

  // -------------------------------------------------------------------------
  // Stateful helper (persists to DB)
  // -------------------------------------------------------------------------

  /**
   * Award XP for a correct guess and persist the updated level and
   * levelTitle to the database.
   *
   * This is the single authoritative path for XP updates — call it from
   * any game controller or gateway that resolves a correct answer.
   *
   * The XP increment is performed atomically in the database so concurrent
   * awards are never lost, and only the `xp`, `level` and `levelTitle`
   * columns are touched — unrelated user columns are never overwritten.
   */
  async handleCorrectGuess(userId: string): Promise<XpResult> {
    // Atomically increment XP and read back the new total. This avoids the
    // read-modify-write race where two concurrent awards both read the same
    // starting XP and one award is lost.
    const rows: Array<{ xp: number; level: number }> =
      await this.userRepo.query(
        'UPDATE users SET xp = xp + $1 WHERE id = $2 RETURNING xp, level',
        [XP_PER_CORRECT_GUESS, userId],
      );

    const updated = rows[0];
    if (!updated) {
      // No matching user — surface the same error shape as findOneOrFail.
      await this.userRepo.findOneOrFail({ where: { id: userId } });
      throw new Error(`User ${userId} not found`);
    }

    const newXp = Number(updated.xp);
    const { level, levelTitle } = getLevelFromXp(newXp);

    // Only update the level columns when the level actually changed, and guard
    // with `level < $new` so a concurrent award that already advanced the level
    // cannot be regressed by a stale write.
    if (level > Number(updated.level)) {
      await this.userRepo.query(
        'UPDATE users SET level = $1, levelTitle = $2 WHERE id = $3 AND level < $1',
        [level, levelTitle, userId],
      );
    }

    return { xp: newXp, level, levelTitle };
  }
}

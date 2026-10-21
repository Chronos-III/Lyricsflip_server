import { GAME_CONSTANTS } from './constants/game.constants';
import { matchAnswer, normalizeAnswer } from './answer-matching';

export interface GuessMatch {
  isCorrect: boolean;
  isExactMatch: boolean;
  points: number;
}

// Re-export the single normaliser so existing imports keep working while
// there is only one implementation in the codebase.
export { normalizeAnswer };

/**
 * Scores a guess against the correct answer (an artist or a song title).
 * Shared by solo play (GameLogicService) and rooms so both score identically.
 * Delegates to the unified matcher so aliases and diacritics are honoured.
 */
export function matchGuess(
  guess: string,
  answer: string,
  aliases: string[] = [],
): GuessMatch {
  const result = matchAnswer(guess, answer, aliases);

  return {
    isCorrect: result.isCorrect,
    isExactMatch: result.isExact,
    points: result.points,
  };
}

// Keep the constants import referenced for downstream consumers that relied
// on this module for scoring thresholds.
export const MIN_PARTIAL_MATCH_LENGTH =
  GAME_CONSTANTS.VALIDATION.MIN_PARTIAL_MATCH_LENGTH;

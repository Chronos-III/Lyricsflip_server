import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Lyrics } from 'src/lyrics/entities/lyrics.entity';
import { matchGuess, normalizeAnswer } from './guess-matcher';
import { Genre, isGenre, toGenre } from 'src/lyrics/entities/genre.enum';
import {
  In,
  IsNull,
  MoreThanOrEqual,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { GameRound } from './entities/game-round.entity';
import {
  GameSession,
  GameSessionStatus,
} from 'src/game-sessions/entities/game-session.entity';
import { GAME_CONSTANTS } from './constants/game.constants';
import { maxRoundPoints, scoreRound } from './round-scoring.util';
import {
  RealtimeEvent,
  RoundEndedPayload,
  RoundStartedPayload,
} from 'src/realtime/realtime.events';

export interface RandomLyricOptions {
  category?: string;
  decade?: string;
  genre?: string;
  excludeIds?: number[];
  /**
   * When set, lyrics this player has already been served within the last
   * `seenWindowDays` days are excluded from the pool.
   */
  userId?: string;
  seenWindowDays?: number;
  /**
   * Genre to fall back to when no explicit genre filter was given (sourced from
   * the player's preferredGenre). Ignored when `ignorePreferences` is true.
   */
  preferredGenre?: string;
  /**
   * Decade to fall back to when no explicit decade filter was given (sourced
   * from the player's preferredDecade). Ignored when `ignorePreferences` is
   * true.
   */
  preferredDecade?: string;
  /**
   * When true, preferredGenre / preferredDecade are not applied even if they
   * are set.
   */
  ignorePreferences?: boolean;
  /**
   * Exact difficulty level (1–5) the lyric must match. When omitted all levels
   * are accepted.
   */
  difficulty?: number;
}

export interface RoundGuessDto {
  roundId: string;
  guessType: 'artist' | 'songTitle';
  guessValue: string;
}

/** Internal shape used by the legacy {@link GameLogicService.checkGuess} method. */
export interface LyricGuessDto {
  lyricId: number;
  guessType: 'artist' | 'songTitle';
  guessValue: string;
}

export interface GuessResult {
  isCorrect: boolean;
  correctAnswer: string;
  explanation?: string;
  points?: number;
  /** Part of `points` that came from answering quickly. */
  speedBonus?: number;
  /** The answer window had closed, so the guess earned nothing. */
  timedOut?: boolean;
  hintsUsed?: number;
}

/** Everything revealed so far by the hints taken on a round. */
export interface RoundHints {
  level: number;
  hintsRemaining: number;
  /** The most this round can now score. */
  maxPoints: number;
  genre?: string | null;
  wordCount?: { songTitle: number; artist: number };
  firstLetter?: { songTitle: string; artist: string };
}

export interface GameLyric {
  id: number;
  lyricSnippet: string;
  songTitle: string;
  artist: string;
  category?: string;
  decade?: string;
  genre?: string;
}

/** Session states in which a player is still in a game. */
const ACTIVE_SESSION_STATUSES = [
  GameSessionStatus.WAITING_FOR_PLAYER,
  GameSessionStatus.IN_PROGRESS,
];

@Injectable()
export class GameLogicService {
  private readonly logger = new Logger(GameLogicService.name);

  constructor(
    @InjectRepository(Lyrics)
    private lyricsRepository: Repository<Lyrics>,
    @InjectRepository(GameRound)
    private roundRepository: Repository<GameRound>,
    @InjectRepository(GameSession)
    private sessionRepository: Repository<GameSession>,
    private readonly configService: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  /** Seconds a player has to answer, configurable per deployment. */
  private get answerWindowSeconds(): number {
    return (
      this.configService.get<number>('ROUND_ANSWER_WINDOW_SECONDS') ??
      GAME_CONSTANTS.LIMITS.ROUND_ANSWER_WINDOW_SECONDS
    );
  }

  /**
   * Records that a lyric has been served to a player, opening the one round
   * that player can guess it in.
   *
   * `issuedAt` is set here, from the server clock, and is what the answer
   * window is measured against when the guess arrives.
   */
  async issueRound(
    userId: string,
    lyricId: number,
    sessionId?: string,
  ): Promise<GameRound> {
    if (sessionId) {
      await this.assertActiveParticipant(userId, sessionId);
    }

    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + GAME_CONSTANTS.LIMITS.ROUND_TIMEOUT_SECONDS * 1000,
    );

    const round = await this.roundRepository.save(
      this.roundRepository.create({
        userId,
        lyricId,
        sessionId: sessionId ?? null,
        issuedAt,
        expiresAt,
        answerWindowSeconds: this.answerWindowSeconds,
        hintsUsed: 0,
        closedAt: null,
      }),
    );

    if (sessionId) {
      await this.touchSession(sessionId);
    }

    const payload: RoundStartedPayload = {
      roundId: round.id,
      sessionId: round.sessionId ?? null,
      userId,
      issuedAt: round.issuedAt,
      expiresAt: round.expiresAt,
      answerWindowSeconds: round.answerWindowSeconds,
    };
    this.events.emit(RealtimeEvent.ROUND_STARTED, payload);

    return round;
  }

  /**
   * Scores a guess against a round served to this player, and closes it.
   *
   * The round is closed with a conditional update before the answer is looked
   * at, so two concurrent guesses cannot both be scored and the answer the
   * first one reveals cannot be replayed.
   *
   * A guess that arrives after the answer window is still evaluated, but earns
   * no points, so looking the answer up elsewhere gains nothing.
   */
  async guessRound(userId: string, dto: RoundGuessDto): Promise<GuessResult> {
    const round = await this.roundRepository.findOne({
      where: { id: dto.roundId, userId },
    });

    // Someone else's round is reported the same as a missing one, so round IDs
    // cannot be probed.
    if (!round) {
      throw new NotFoundException('Round not found');
    }

    if (round.closedAt) {
      throw new ConflictException('This round has already been guessed');
    }

    const now = new Date();

    if (round.expiresAt.getTime() <= now.getTime()) {
      await this.roundRepository.update(
        { id: round.id, closedAt: IsNull() },
        { closedAt: now },
      );
      this.emitRoundEnded(round, {
        isCorrect: false,
        points: 0,
        speedBonus: 0,
        timedOut: true,
      });
      throw new GoneException('This round has expired');
    }

    const closed = await this.roundRepository.update(
      { id: round.id, closedAt: IsNull() },
      { closedAt: now },
    );

    if (!closed.affected) {
      throw new ConflictException('This round has already been guessed');
    }

    const result = await this.checkGuess({
      lyricId: round.lyricId,
      guessType: dto.guessType,
      guessValue: dto.guessValue,
    });

    const score = scoreRound({
      basePoints: result.points ?? 0,
      isCorrect: result.isCorrect,
      elapsedMs: now.getTime() - round.issuedAt.getTime(),
      windowMs: round.answerWindowSeconds * 1000,
      hintsUsed: round.hintsUsed,
    });

    const scored: GuessResult = {
      ...result,
      points: score.points,
      speedBonus: score.speedBonus,
      timedOut: score.timedOut,
      hintsUsed: round.hintsUsed,
    };

    if (score.timedOut) {
      scored.explanation = `Too late, no points awarded. ${result.explanation}`;
    }

    this.emitRoundEnded(round, {
      isCorrect: result.isCorrect && !score.timedOut,
      points: score.points,
      speedBonus: score.speedBonus,
      timedOut: score.timedOut,
    });

    if (round.sessionId) {
      await this.touchSession(round.sessionId);
    }

    return scored;
  }

  /**
   * Reveals the next hint for an open round: the genre plus the number of
   * words in the song title, then the word counts, then the first letters.
   *
   * The decade is deliberately not part of the hint ladder: it is already
   * shown with the round, so revealing it would charge the player for
   * information they already had.
   */
  async revealHint(userId: string, roundId: string): Promise<RoundHints> {
    const round = await this.roundRepository.findOne({
      where: { id: roundId, userId },
    });

    if (!round) {
      throw new NotFoundException('Round not found');
    }

    if (round.closedAt) {
      throw new ConflictException('This round has already been guessed');
    }

    if (round.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This round has expired');
    }

    const nextLevel = round.hintsUsed + 1;

    if (nextLevel > GAME_CONSTANTS.HINTS.MAX_LEVEL) {
      throw new BadRequestException('No hints remaining for this round');
    }

    const lyric = await this.lyricsRepository.findOne({
      where: { id: round.lyricId },
    });

    if (!lyric) {
      throw new NotFoundException('Lyric not found');
    }

    await this.roundRepository.update(
      { id: round.id },
      { hintsUsed: nextLevel },
    );

    const hints: RoundHints = {
      level: nextLevel,
      hintsRemaining: GAME_CONSTANTS.HINTS.MAX_LEVEL - nextLevel,
      maxPoints: maxRoundPoints(nextLevel),
    };

    if (nextLevel >= 1) {
      hints.genre = lyric.genre ?? null;
      hints.wordCount = {
        songTitle: countWords(lyric.songTitle),
        artist: countWords(lyric.artist),
      };
    }

    if (nextLevel >= 2) {
      hints.wordCount = {
        songTitle: countWords(lyric.songTitle),
        artist: countWords(lyric.artist),
      };
    }

    if (nextLevel >= 3) {
      hints.firstLetter = {
        songTitle: firstLetter(lyric.songTitle),
        artist: firstLetter(lyric.artist),
      };
    }

    return hints;
  }

  /**
   * Legacy guess check used by {@link GameLogicService.guessRound} and the
   * older lyric-based endpoints.
   */
  async checkGuess(dto: LyricGuessDto): Promise<GuessResult> {
    const lyric = await this.lyricsRepository.findOne({
      where: { id: dto.lyricId },
    });

    if (!lyric) {
      throw new NotFoundException('Lyric not found');
    }

    const expected =
      dto.guessType === 'artist' ? lyric.artist : lyric.songTitle;
    const isCorrect = matchGuess(dto.guessValue, expected);

    return {
      isCorrect,
      correctAnswer: expected,
      explanation: isCorrect
        ? 'Correct!'
        : `Not quite. The answer was "${expected}".`,
      points: isCorrect ? GAME_CONSTANTS.SCORING.BASE_POINTS : 0,
    };
  }

  /**
   * Returns a random lyric for a new round, honouring the caller's filters and
   * (unless disabled) the player's genre/decade preferences.
   */
  async getRandomLyric(
    options: RandomLyricOptions = {},
  ): Promise<GameLyric | null> {
    const qb = this.lyricsRepository.createQueryBuilder('lyric');

    if (options.category) {
      qb.andWhere('lyric.category = :category', {
        category: options.category,
      });
    }

    if (options.decade) {
      qb.andWhere('lyric.decade = :decade', { decade: options.decade });
    }

    if (options.genre) {
      qb.andWhere('lyric.genre = :genre', { genre: options.genre });
    }

    if (options.difficulty) {
      qb.andWhere('lyric.difficulty = :difficulty', {
        difficulty: options.difficulty,
      });
    }

    if (options.excludeIds?.length) {
      qb.andWhere('lyric.id NOT IN (:...excludeIds)', {
        excludeIds: options.excludeIds,
      });
    }

    if (options.userId && options.seenWindowDays) {
      const cutoff = new Date(
        Date.now() - options.seenWindowDays * 24 * 60 * 60 * 1000,
      );
      const seen = await this.roundRepository.find({
        where: {
          userId: options.userId,
          issuedAt: MoreThanOrEqual(cutoff),
        },
        select: ['lyricId'],
      });
      const seenIds = seen.map((r) => r.lyricId);
      if (seenIds.length) {
        qb.andWhere('lyric.id NOT IN (:...seenIds)', { seenIds });
      }
    }

    if (!options.ignorePreferences) {
      if (!options.genre && options.preferredGenre) {
        qb.andWhere('lyric.genre = :preferredGenre', {
          preferredGenre: options.preferredGenre,
        });
      }
      if (!options.decade && options.preferredDecade) {
        qb.andWhere('lyric.decade = :preferredDecade', {
          preferredDecade: options.preferredDecade,
        });
      }
    }

    qb.orderBy('RANDOM()').limit(1);

    const lyric = await qb.getOne();

    if (!lyric) {
      return null;
    }

    return {
      id: lyric.id,
      lyricSnippet: lyric.lyricSnippet,
      songTitle: lyric.songTitle,
      artist: lyric.artist,
      category: lyric.category,
      decade: lyric.decade,
      genre: lyric.genre,
    };
  }

  /**
   * Ensures the player is an active participant of the given session.
   */
  private async assertActiveParticipant(
    userId: string,
    sessionId: string,
  ): Promise<void> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
    });

    if (!session) {
      throw new NotFoundException('Session not found');
    }

    if (!ACTIVE_SESSION_STATUSES.includes(session.status)) {
      throw new ConflictException('Session is not active');
    }

    const participants = await this.sessionRepository.manager
      .getRepository('game_session_players')
      .findOne({ where: { sessionId, userId } })
      .catch(() => null);

    if (!participants) {
      throw new ConflictException('Player is not part of this session');
    }
  }

  /** Bumps the session's last-activity timestamp. */
  private async touchSession(sessionId: string): Promise<void> {
    await this.sessionRepository.update(
      { id: sessionId },
      { lastActivityAt: new Date() },
    );
  }

  private emitRoundEnded(
    round: GameRound,
    result: Omit<RoundEndedPayload, 'roundId' | 'sessionId' | 'userId'>,
  ): void {
    const payload: RoundEndedPayload = {
      roundId: round.id,
      sessionId: round.sessionId ?? null,
      userId: round.userId,
      ...result,
    };
    this.events.emit(RealtimeEvent.ROUND_ENDED, payload);
  }
}

/** Counts the whitespace-separated words in a string. */
function countWords(value: string): number {
  return value.trim().split(/\s+/).filter(Boolean).length;
}

/** Returns the first character of a string, uppercased. */
function firstLetter(value: string): string {
  return value.trim().charAt(0).toUpperCase();
}

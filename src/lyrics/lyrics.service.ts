import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cache } from 'cache-manager';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Lyrics } from './entities/lyrics.entity';
import { CreateLyricsDto } from './dto/create-lyrics.dto';
import { UpdateLyricsDto } from './dto/update-lyrics.dto';
import { User } from '../users/entities/user.entity';
import { cacheConfig } from '../config/cache.config';
import { Genre } from './entities/genre.enum';
import { MAX_PAGE_SIZE } from '../common/dto/pagination-query.dto';
import { normalizeDecade } from '../game/progression.util';

/**
 * Maximum length of a lyric snippet served to players. Full lyric text is
 * never exposed; only a short snippet plus answer metadata is returned.
 */
export const MAX_LYRIC_SNIPPET_LENGTH = 150;

export interface LyricsCacheStats {
  keys: number;
  keysByType: {
    lyrics: number;
    random: number;
    category: number;
    search: number;
  };
  ttlMs: number;
}

@Injectable()
export class LyricsService {
  private readonly cacheTtlMs: number;

  /**
   * Every lyrics cache key this service has written, with its expiry time.
   * cache-manager has no prefix delete, so invalidation deletes these keys.
   * The global store is in-memory and per-process, which this matches;
   * moving to Redis (issue #115) would replace this with a prefix scan.
   */
  private readonly cachedKeys = new Map<string, number>();

  /**
   * Bumped on every invalidation. A read that started before a write must not
   * repopulate the cache with the data it loaded before that write.
   */
  private cacheGeneration = 0;

  constructor(
    @InjectRepository(Lyrics)
    private readonly lyricsRepository: Repository<Lyrics>,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {
    this.cacheTtlMs = cacheConfig.lyricsTtlMs;
  }

  /**
   * Reject snippets that exceed the content policy limit. Full lyric text is
   * never served to players, so the snippet is the only lyric surface and it
   * must stay short.
   */
  private assertSnippetWithinLimit(snippet: string): void {
    if (snippet.length > MAX_LYRIC_SNIPPET_LENGTH) {
      throw new BadRequestException(
        `lyricSnippet must be at most ${MAX_LYRIC_SNIPPET_LENGTH} characters`,
      );
    }
  }

  async create(createLyricsDto: CreateLyricsDto, user: User): Promise<Lyrics> {
    // Derive lyricSnippet from content when the caller did not supply one.
    // The entity column is non-nullable so we must guarantee a value here.
    const lyricSnippet =
      createLyricsDto.lyricSnippet?.trim() ||
      (createLyricsDto.content ?? '').slice(0, MAX_LYRIC_SNIPPET_LENGTH).trim();

    this.assertSnippetWithinLimit(lyricSnippet);

    const lyrics = this.lyricsRepository.create({
      ...createLyricsDto,
      lyricSnippet,
      // Store decades in the canonical "1990s" format used by the seed and
      // the MusicDecade preference enum.
      decade: createLyricsDto.decade
        ? normalizeDecade(createLyricsDto.decade.toString())
        : createLyricsDto.decade,
      createdBy: user,
    });
    const savedLyrics = await this.lyricsRepository.save(lyrics);

    // Clear relevant caches when new lyrics are added
    await this.clearCache();

    return savedLyrics;
  }

  async findAll(
    genre?: string,
    decade?: number | string,
    limit: number = MAX_PAGE_SIZE,
    offset: number = 0,
  ): Promise<Lyrics[]> {
    const query = this.lyricsRepository
      .createQueryBuilder('lyrics')
      .leftJoinAndSelect('lyrics.createdBy', 'user');

    // Apply genre filter if provided
    if (genre) {
      // Validate genre against enum values
      const validGenres = Object.values(Genre);
      if (!validGenres.includes(genre as Genre)) {
        throw new BadRequestException(
          `Invalid genre. Valid genres are: ${validGenres.join(', ')}`,
        );
      }
      query.andWhere('lyrics.genre = :genre', { genre });
    }

    // Apply decade filter if provided. Accept both "1990" and "1990s" and
    // normalise to the stored "1990s" format before querying.
    if (decade !== undefined && decade !== null && decade !== '') {
      const decadeStr = normalizeDecade(decade.toString());
      if (!decadeStr) {
        throw new BadRequestException(
          'Invalid decade. Please provide a decade such as 1990 or 1990s',
        );
      }

      query.andWhere('lyrics.decade = :decade', { decade: decadeStr });
    }

    // Only return active lyrics
    query.andWhere('lyrics.isActive = :isActive', { isActive: true });

    // Always capped, so no caller can pull the whole table in one request
    const results = await query
      .orderBy('lyrics.id', 'ASC')
      .take(limit)
      .skip(offset)
      .getMany();

    // Return empty array instead of throwing exception for no results
    return results;
  }

  /**
   * Count lyrics, optionally filtered by active state. Used by the admin
   * listing to populate pagination metadata.
   */
  async count(isActive?: boolean): Promise<number> {
    if (isActive === undefined) {
      return this.lyricsRepository.count();
    }

    return this.lyricsRepository.count({ where: { isActive } });
  }

  async findOne(id: number): Promise<Lyrics> {
    // Validate ID
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const cacheKey = `${cacheConfig.keys.lyrics}${id}`;

    return this.getOrLoad(cacheKey, this.cacheTtlMs, async () => {
      const dbLyrics = await this.lyricsRepository.findOne({
        where: { id, isActive: true },
        relations: ['createdBy'],
      });

      if (!dbLyrics) {
        throw new NotFoundException('Lyrics not found');
      }

      return dbLyrics;
    });
  }

  async update(
    id: number, // Fixed: should be number, not string
    updateLyricsDto: UpdateLyricsDto,
    user: User,
  ): Promise<Lyrics> {
    // Validate ID
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const lyrics = await this.lyricsRepository.findOne({
      where: { id, isActive: true },
      relations: ['createdBy'],
    });

    if (!lyrics) {
      throw new NotFoundException('Lyrics not found');
    }

    // Optional: Check if user is admin or creator
    // if (lyrics.createdBy.id !== user.id && !user.isAdmin) {
    //   throw new ForbiddenException('You can only update your own lyrics');
    // }

    // Update lyrics with new data
    Object.assign(lyrics, updateLyricsDto);
    lyrics.updatedAt = new Date(); // Assuming you have updatedAt field

    if (updateLyricsDto.decade !== undefined && updateLyricsDto.decade !== null) {
      lyrics.decade = normalizeDecade(updateLyricsDto.decade.toString());
    }

    if (updateLyricsDto.lyricSnippet !== undefined) {
      this.assertSnippetWithinLimit(updateLyricsDto.lyricSnippet.trim());
    }

    const updatedLyrics = await this.lyricsRepository.save(lyrics);

    // The edited lyric may appear in any list, category, random or search
    // result, so drop every lyrics cache entry, not just lyrics:{id}.
    await this.clearCache();

    return updatedLyrics;
  }

  async remove(id: number): Promise<void> {
    // Fixed: should be number, not string
    // Validate ID
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const lyrics = await this.lyricsRepository.findOne({
      where: { id, isActive: true },
    });

    if (!lyrics) {
      throw new NotFoundException('Lyrics not found');
    }

    // Soft delete by setting isActive to false instead of hard delete
    lyrics.isActive = false;
    await this.lyricsRepository.save(lyrics);

    // Drop every lyrics cache entry that could still contain this lyric
    await this.clearCache();
  }

  /**
   * Normalise a value for alias comparison: lower-case, trim, and collapse
   * internal whitespace so "JAY Z" and "Jay-Z" compare equal.
   */
  private normalizeAnswer(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  /**
   * Check whether a guess matches the canonical value or any of its aliases.
   * Comparison is case- and punctuation-insensitive so "Jay-Z" matches
   * "JAY Z" and "WizKid" matches "Wizkid".
   */
  matchesAnswer(
    guess: string,
    canonical: string,
    aliases: string[] = [],
  ): boolean {
    if (!guess) {
      return false;
    }

    const normalizedGuess = this.norma

/* … truncated 927 chars — edit only what you need near the top … */
    const normalizedGuess = this.normalizeAnswer(guess);
    if (!normalizedGuess) {
      return false;
    }

    const candidates = [canonical, ...(aliases ?? [])];
    return candidates.some(
      (candidate) =>
        candidate != null &&
        this.normalizeAnswer(candidate) === normalizedGuess,
    );
  }

  /**
   * Score a guess against a lyric's canonical artist/title and their aliases.
   * A guess that matches an alias is scored as correct.
   */
  scoreGuess(
    lyrics: Lyrics,
    guess: { artist?: string; title?: string },
  ): { artistCorrect: boolean; titleCorrect: boolean } {
    return {
      artistCorrect: this.matchesAnswer(
        guess.artist ?? '',
        lyrics.artist,
        lyrics.artistAliases,
      ),
      titleCorrect: this.matchesAnswer(
        guess.title ?? '',
        lyrics.songTitle,
        lyrics.titleAliases,
      ),
    };
  }

  /**
   * Load a value through the cache, recording the key so it can be
   * invalidated later. A read that began before an invalidation must not
   * repopulate the cache with stale data, hence the generation check.
   */
  private async getOrLoad<T>(
    cacheKey: string,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.cacheManager.get<T>(cacheKey);
    if (cached !== undefined && cached !== null) {
      return cached;
    }

    const generation = this.cacheGeneration;
    const value = await loader();

    if (generation === this.cacheGeneration) {
      await this.cacheManager.set(cacheKey, value, ttlMs);
      this.cachedKeys.set(cacheKey, Date.now() + ttlMs);
    }

    return value;
  }

  /**
   * Return a random active lyric. The result is cached briefly so repeated
   * calls do not hammer the database.
   */
  async getRandomLyrics(): Promise<Lyrics> {
    const cacheKey = `${cacheConfig.keys.random}${Date.now()}`;

    const lyrics = await this.lyricsRepository
      .createQueryBuilder('lyrics')
      .leftJoinAndSelect('lyrics.createdBy', 'user')
      .where('lyrics.isActive = :isActive', { isActive: true })
      .orderBy('RANDOM()')
      .getOne();

    if (!lyrics) {
      throw new NotFoundException('No lyrics available');
    }

    await this.cacheManager.set(cacheKey, lyrics, this.cacheTtlMs);
    this.cachedKeys.set(cacheKey, Date.now() + this.cacheTtlMs);

    return lyrics;
  }

  /**
   * Return active lyrics for a genre or decade. Exactly one filter is used;
   * genre takes precedence when both are supplied.
   */
  async getLyricsByCategory(
    category: { genre?: string; decade?: number },
    limit: number = MAX_PAGE_SIZE,
    offset: number = 0,
  ): Promise<Lyrics[]> {
    const { genre, decade } = category;
    const cacheKey = `${cacheConfig.keys.category}${genre ?? ''}:${decade ?? ''}:${limit}:${offset}`;

    return this.getOrLoad(cacheKey, this.cacheTtlMs, async () => {
      const query = this.lyricsRepository
        .createQueryBuilder('lyrics')
        .leftJoinAndSelect('lyrics.createdBy', 'user')
        .where('lyrics.isActive = :isActive', { isActive: true });

      if (genre) {
        const validGenres = Object.values(Genre);
        if (!validGenres.includes(genre as Genre)) {
          throw new BadRequestException(
            `Invalid genre. Valid genres are: ${validGenres.join(', ')}`,
          );
        }
        query.andWhere('lyrics.genre = :genre', { genre });
      } else if (decade) {
        if (
          decade < 1900 ||
          decade > new Date().getFullYear() ||
          decade % 10 !== 0
        ) {
          throw new BadRequestException(
            'Invalid decade. Please provide a 4-digit year in decades (e.g., 1990, 2000, 2010)',
          );
        }
        query.andWhere('lyrics.decade = :decade', { decade: decade.toString() });
      }

      return query
        .orderBy('lyrics.id', 'ASC')
        .take(limit)
        .skip(offset)
        .getMany();
    });
  }

  /**
   * Search active lyrics by artist, song title or snippet. The term is
   * matched case-insensitively against the songTitle column.
   */
  async searchLyrics(
    term: string,
    limit: number = MAX_PAGE_SIZE,
    offset: number = 0,
  ): Promise<Lyrics[]> {
    const trimmed = (term ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('Search term must not be empty');
    }

    const cacheKey = `${cacheConfig.keys.search}${trimmed.toLowerCase()}:${limit}:${offset}`;

    return this.getOrLoad(cacheKey, this.cacheTtlMs, async () => {
      return this.lyricsRepository
        .createQueryBuilder('lyrics')
        .leftJoinAndSelect('lyrics.createdBy', 'user')
        .where('lyrics.isActive = :isActive', { isActive: true })
        .andWhere(
          '(lyrics.songTitle ILIKE :term OR lyrics.artist ILIKE :term OR lyrics.lyricSnippet ILIKE :term)',
          { term: `%${trimmed}%` },
        )
        .orderBy('lyrics.id', 'ASC')
        .take(limit)
        .skip(offset)
        .getMany();
    });
  }

  /**
   * Count lyrics, optionally restricted to active (or inactive) rows.
   */
  async count(isActive?: boolean): Promise<number> {
    const where = isActive === undefined ? {} : { isActive };
    return this.lyricsRepository.count({ where });
  }

  /**
   * Restore a soft-deleted lyric by setting isActive back to true.
   */
  async restore(id: number): Promise<Lyrics> {
    if (!id || id <= 0) {
      throw new BadRequestException('Invalid lyrics ID');
    }

    const lyrics = await this.lyricsRepository.findOne({ where: { id } });

    if (!lyrics) {
      throw new NotFoundException('Lyrics not found');
    }

    lyrics.isActive = true;
    const restored = await this.lyricsRepository.save(lyrics);

    await this.clearCache();

    return restored;
  }

  /**
   * Find a lyric by its artist and song title (case-insensitive).
   */
  async findByArtistAndTitle(
    artist: string,
    songTitle: string,
  ): Promise<Lyrics | null> {
    if (!artist || !songTitle) {
      throw new BadRequestException('artist and songTitle are required');
    }

    return this.lyricsRepository
      .createQueryBuilder('lyrics')
      .leftJoinAndSelect('lyrics.createdBy', 'user')
      .where('lyrics.isActive = :isActive', { isActive: true })
      .andWhere('LOWER(lyrics.artist) = LOWER(:artist)', { artist })
      .andWhere('LOWER(lyrics.songTitle) = LOWER(:songTitle)', { songTitle })
      .getOne();
  }

  /**
   * Drop every lyrics cache entry this service has written.
   */
  async clearCache(): Promise<void> {
    this.cacheGeneration += 1;

    const now = Date.now();
    const deletions: Promise<unknown>[] = [];

    for (const [key, expiresAt] of this.cachedKeys) {
      if (expiresAt > now) {
        deletions.push(this.cacheManager.del(key));
      }
      this.cachedKeys.delete(key);
    }

    await Promise.all(deletions);
  }

  /**
   * Alias of clearCache() for callers that use invalidation terminology.
   */
  async invalidateCache(): Promise<void> {
    return this.clearCache();
  }

  /**
   * Report how many cache keys are live, grouped by key type.
   */
  async getCacheStats(): Promise<LyricsCacheStats> {
    const now = Date.now();
    const keysByType = {
      lyrics: 0,
      random: 0,
      category: 0,
      search: 0,
    };

    for (const [key, expiresAt] of this.cachedKeys) {
      if (expiresAt <= now) {
        continue;
      }
      if (key.startsWith(cacheConfig.keys.lyrics)) {
        keysByType.lyrics += 1;
      } else if (key.startsWith(cacheConfig.keys.random)) {
        keysByType.random += 1;
      } else if (key.startsWith(cacheConfig.keys.category)) {
        keysByType.category += 1;
      } else if (key.startsWith(cacheConfig.keys.search)) {
        keysByType.search += 1;
      }
    }

    return {
      keys: Object.values(keysByType).reduce((sum, n) => sum + n, 0),
      keysByType,
      ttlMs: this.cacheTtlMs,
    };
  }
}

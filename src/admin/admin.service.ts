import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { UsersService } from '../users/users.service';
import { LyricsService } from 'src/lyrics/lyrics.service';
import { CreateLyricsDto } from 'src/lyrics/dto/create-lyrics.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { AdminUserQueryDto } from './dto/admin-user-query.dto';
import { AdminLyricQueryDto } from './dto/admin-lyric-query.dto';

export interface LyricsImportRowReport {
  row: number;
  status: 'created' | 'updated' | 'skipped' | 'error';
  errors?: string[];
}

export interface LyricsImportReport {
  dryRun: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: LyricsImportRowReport[];
}

export interface PaginatedResult<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number };
}

@Injectable()
export class AdminService {
  constructor(
    private usersService: UsersService,
    private lyricsService: LyricsService,
  ) {}

  async findAllUsers(
    query: AdminUserQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const [data, total] = await Promise.all([
      this.usersService.findAll(limit, offset),
      this.usersService.count(),
    ]);
    return { data, meta: { total, limit, offset } };
  }

  async deleteUser(id: string) {
    const result = await this.usersService.remove(id);
    return result.message || 'User deleted successfully';
  }

  async findAllLyrics(
    query: AdminLyricQueryDto,
  ): Promise<PaginatedResult<unknown>> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const isActive =
      query.status === 'inactive'
        ? false
        : query.status === 'active'
          ? true
          : undefined;
    const [data, total] = await Promise.all([
      this.lyricsService.findAll(limit, offset, query.sortBy, query.sortOrder),
      this.lyricsService.count(isActive),
    ]);
    return { data, meta: { total, limit, offset } };
  }

  deleteLyric(id: number) {
    return this.lyricsService.remove(id);
  }

  async restoreLyric(id: number) {
    const lyric = await this.lyricsService.findOne(id);
    if (!lyric) {
      throw new NotFoundException(`Lyric with id ${id} not found`);
    }
    const restored = await this.lyricsService.restore(id);
    await this.lyricsService.invalidateCache();
    return restored;
  }

  async importLyrics(
    file: { buffer: Buffer; originalname?: string; mimetype?: string },
    dryRun = false,
    user?: { id: string; [key: string]: unknown },
  ): Promise<LyricsImportReport> {
    if (!file || !file.buffer) {
      throw new BadRequestException('A CSV or JSON file is required');
    }

    const rawRows = this.parseImportFile(file);
    const report: LyricsImportReport = {
      dryRun,
      total: rawRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      rows: [],
    };

    for (let i = 0; i < rawRows.length; i++) {
      const rowNumber = i + 1;
      const dto = plainToInstance(CreateLyricsDto, rawRows[i]);
      const validationErrors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: false,
      });

      if (validationErrors.length > 0) {
        report.errors++;
        report.rows.push({
          row: rowNumber,
          status: 'error',
          errors: validationErrors.flatMap((e) =>
            Object.values(e.constraints ?? {}),
          ),
        });
        continue;
      }

      const existing = await this.lyricsService.findByArtistAndTitle(
        dto.artist,
        dto.songTitle,
      );

      if (dryRun) {
        if (existing) {
          report.updated++;
          report.rows.push({ row: rowNumber, status: 'updated' });
        } else {
          report.created++;
          report.rows.push({ row: rowNumber, status: 'created' });
        }
        continue;
      }

      if (existing) {
        await this.lyricsService.update(existing.id, dto, user);
        report.updated++;
        report.rows.push({ row: rowNumber, status: 'updated' });
      } else {
        await this.lyricsService.create(dto, user);
        report.created++;
        report.rows.push({ row: rowNumber, status: 'created' });
      }
    }

    if (!dryRun) {
      await this.lyricsService.invalidateCache();
    }

    return report;
  }

  private parseImportFile(file: {
    buffer: Buffer;
    originalname?: string;
    mimetype?: string;
  }): Record<string, unknown>[] {
    const content = file.buffer.toString('utf-8').trim();
    const name = (file.originalname ?? '').toLowerCase();
    const isJson =
      name.endsWith('.json') ||
      file.mimetype === 'application/json' ||
      content.startsWith('[') ||
      content.startsWith('{');

    if (isJson) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new BadRequestException('Invalid JSON file');
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.filter(
        (row): row is Record<string, unknown> =>
          typeof row === 'object' && row !== null,
      );
    }

    return this.parseCsv(content);
  }

  private parseCsv(content: string): Record<string, unknown>[] {
    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '');
    if (lines.length === 0) {
      return [];
    }

    const headers = this.splitCsvLine(lines[0]).map((h) => h.trim());
    const rows: Record<string, unknown>[] = [];

    for (let i = 1; i < lines.length; i++) {
      const values = this.splitCsvLine(lines[i]);
      const row: Record<string, unknown> = {};
      headers.forEach((header, index) => {
        row[header] = values[index] ?? '';
      });
      rows.push(row);
    }

    return rows;
  }

  private splitCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        values.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current);
    return values;
  }
}

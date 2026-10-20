import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ImportLyricsDto } from './dto/import-lyrics.dto';
import { GrantMockBalanceMode } from './dto/grant-mock-balance.dto';
import { MockTokenService } from '../tokens/services/mock-token.service';
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
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly mockTokenService: MockTokenService,
  ) {}

  async findAllUsers(query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const [items, total] = await this.userRepository.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    return { items, total, page, limit };
  }

  async deleteUser(id: string) {
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    await this.userRepository.remove(user);
    return { success: true };
  }

  async grantMockBalance(
    userId: string,
    amount: string,
    mode: GrantMockBalanceMode = GrantMockBalanceMode.ADD,
  ) {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return this.mockTokenService.grantMockBalance(userId, amount, mode);
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
    const restored = await this.lyricsService.restore(id);
    if (!restored) {
      throw new NotFoundException(`Lyric with id ${id} not found`);
    }
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

  async findAllLyrics(query: PaginationQueryDto, status?: string) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const qb = this.userRepository.manager
      .createQueryBuilder()
      .select('lyric')
      .from('lyrics', 'lyric')
      .skip((page - 1) * limit)
      .take(limit);
    if (status) {
      qb.where('lyric.status = :status', { status });
    }
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit };
  }

  async importLyrics(file: Express.Multer.File, dryRun: boolean) {
    return { imported: 0, dryRun, filename: file?.originalname };
  }

  async restoreLyric(id: number) {
    return { success: true, id };
  }

  async deleteLyric(id: number) {
    return { success: true, id };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ImportLyricsDto } from './dto/import-lyrics.dto';
import { GrantMockBalanceMode } from './dto/grant-mock-balance.dto';
import { MockTokenService } from '../tokens/services/mock-token.service';

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

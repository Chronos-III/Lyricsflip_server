import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { GameCategory } from '../../game-sessions/entities/game-session.entity';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class TopScoresQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: GameCategory,
    description: 'Filter top scores by game category',
  })
  @IsOptional()
  @IsEnum(GameCategory)
  category?: GameCategory;
}
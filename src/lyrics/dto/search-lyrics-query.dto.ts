import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class SearchLyricsQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description: 'Search query used to find matching lyrics',
    example: 'love',
    minLength: 2,
    maxLength: 100,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;
}
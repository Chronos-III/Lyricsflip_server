import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class DeleteAccountDto {
  @ApiProperty({
    description: 'The current password of the account, used to re-authenticate before deletion.',
    example: 'S3cureP@ssw0rd',
  })
  @IsString()
  @MinLength(1)
  password: string;
}
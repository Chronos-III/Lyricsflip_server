import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({
    description: 'The password reset token issued by the forgot-password endpoint',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  token: string;

  @ApiProperty({
    description:
      'The new password. Must be 8-72 characters and contain at least one lowercase letter, one uppercase letter and one digit.',
    example: 'NewStrongPass1',
    minLength: 8,
    maxLength: 72,
  })
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  @Matches(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, {
    message:
      'password must contain at least one lowercase letter, one uppercase letter and one digit',
  })
  password: string;
}
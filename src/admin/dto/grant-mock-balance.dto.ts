import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';

export enum GrantMockBalanceMode {
  ADD = 'add',
  SET = 'set',
}

/**
 * Decimal string amount, validated like `wagerAmount` (converted to stroops
 * downstream). Never an integer number.
 */
const DECIMAL_AMOUNT_REGEX = /^\d+(\.\d{1,7})?$/;

export class GrantMockBalanceDto {
  @ApiProperty({
    description: 'Amount to credit (or set) as a decimal string, e.g. "50.5"',
    example: '50.5',
  })
  @Matches(DECIMAL_AMOUNT_REGEX, {
    message: 'amount must be a positive decimal string with up to 7 decimals',
  })
  amount: string;

  @ApiPropertyOptional({
    description: 'Whether to add to the current balance or set it',
    enum: GrantMockBalanceMode,
    default: GrantMockBalanceMode.ADD,
  })
  @IsOptional()
  @IsEnum(GrantMockBalanceMode)
  mode?: GrantMockBalanceMode;
}

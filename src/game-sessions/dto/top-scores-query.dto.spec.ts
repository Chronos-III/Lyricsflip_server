import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TopScoresQueryDto } from './top-scores-query.dto';
import { GameCategory } from '../../game-sessions/entities/game-session.entity';

describe('TopScoresQueryDto', () => {
  const build = (payload: Record<string, unknown>) =>
    plainToInstance(TopScoresQueryDto, payload);

  it('accepts a valid category from GameCategory', async () => {
    const dto = build({ category: GameCategory.POP });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects an invalid category', async () => {
    const dto = build({ category: 'not-a-real-category' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'category')).toBe(true);
  });

  it('rejects limit=500', async () => {
    const dto = build({ limit: 500 });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'limit')).toBe(true);
  });

  it('accepts a valid limit', async () => {
    const dto = build({ limit: 10 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty payload (all fields optional)', async () => {
    const dto = build({});
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
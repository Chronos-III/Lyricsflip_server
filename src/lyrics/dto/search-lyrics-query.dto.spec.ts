import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchLyricsQueryDto } from './search-lyrics-query.dto';

describe('SearchLyricsQueryDto', () => {
  const build = (plain: Record<string, unknown>): SearchLyricsQueryDto =>
    plainToInstance(SearchLyricsQueryDto, plain);

  const errorProperties = async (
    dto: SearchLyricsQueryDto,
  ): Promise<string[]> => {
    const errors = await validate(dto);
    return errors.map((error) => error.property);
  };

  it('rejects a query shorter than 2 characters', async () => {
    const dto = build({ q: 'a' });

    const properties = await errorProperties(dto);

    expect(properties).toContain('q');
  });

  it('trims the query and accepts it when the trimmed value is valid', async () => {
    const dto = build({ q: ' ab ' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.q).toBe('ab');
  });

  it('rejects a query longer than 100 characters', async () => {
    const dto = build({ q: 'a'.repeat(101) });

    const properties = await errorProperties(dto);

    expect(properties).toContain('q');
  });

  it('rejects a non-string query', async () => {
    const dto = build({ q: 123 });

    const properties = await errorProperties(dto);

    expect(properties).toContain('q');
  });

  it('rejects a limit above the inherited maximum', async () => {
    const dto = build({ q: 'valid query', limit: 500 });

    const properties = await errorProperties(dto);

    expect(properties).toContain('limit');
  });

  it('accepts a valid query with valid pagination', async () => {
    const dto = build({ q: 'valid query', limit: 10, offset: 0 });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.q).toBe('valid query');
    expect(dto.limit).toBe(10);
    expect(dto.offset).toBe(0);
  });
});
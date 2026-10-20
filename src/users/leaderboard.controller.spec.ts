import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

const leaderboardMock = {
  data: [
    { id: '1', username: 'alice', xp: 100, level: 2, rank: 1 },
    { id: '2', username: 'bob', xp: 80, level: 1, rank: 2 },
  ],
  meta: { total: 2, limit: 2, offset: 0, sort: 'xp', order: 'DESC' },
};

describe('UsersController - Leaderboard', () => {
  let controller: UsersController;
  let service: UsersService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            getLeaderboard: jest.fn().mockResolvedValue(leaderboardMock),
          },
        },
      ],
    }).compile();
    controller = module.get<UsersController>(UsersController);
    service = module.get<UsersService>(UsersService);
  });

  it('should return leaderboard from controller', async () => {
    const options = { limit: 2, offset: 0, sort: 'xp', order: 'DESC' as const };
    const result = await controller.getLeaderboard(options);
    expect(result).toEqual(leaderboardMock);
    expect(service.getLeaderboard).toHaveBeenCalledWith(options);
  });

  it('should include myRank when a bearer token is present', async () => {
    const options = { limit: 2, offset: 0, sort: 'xp', order: 'DESC' as const };
    const withRank = { ...leaderboardMock, myRank: 1 };
    (service.getLeaderboard as jest.Mock).mockResolvedValueOnce(withRank);

    const req = { user: { id: '1', username: 'alice' } } as any;
    const result = await controller.getLeaderboard(options, req);

    expect(result).toEqual(withRank);
    expect(result.myRank).toBe(1);
    expect(service.getLeaderboard).toHaveBeenCalledWith(options, '1');
  });
});
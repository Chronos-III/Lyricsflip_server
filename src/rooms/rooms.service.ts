import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LessThanOrEqual, Repository, In } from 'typeorm';
import { Room } from './entities/room.entity';
import { RoomUser } from './entities/room-user.entity';
import { Lyrics } from '../lyrics/entities/lyrics.entity';
import { CreateRoomDto } from './dto/create-room.dto';
import { GuessLyricDto } from './dto/guess-lyric.dto';
import { GuessType } from '../game/dto/guess.dto';
import { matchGuess } from '../game/guess-matcher';
import * as crypto from 'crypto';
import { JobLockService } from '../tokens/services/job-lock.service';

/** Lyric fields that are safe to show before a player has guessed. */
export interface RoomLyricView {
  id: number;
  lyricSnippet: string;
  category?: string;
  genre?: string;
  decade?: string;
  // Only present once the requesting player has guessed.
  artist?: string;
  songTitle?: string;
}

/** Public summary of a player. Never carries other User fields. */
export interface RoomPlayerView {
  id: string;
  username: string | null;
  hasGuessed: boolean;
  score: number;
}

export interface RoomStatusView {
  id: string;
  name: string;
  createdAt: Date;
  expiresAt: Date;
  isClosed: boolean;
  lyric: RoomLyricView;
  players: RoomPlayerView[];
}

export interface RoomGuessResult {
  roomId: string;
  guessType: GuessType;
  guess: string;
  isCorrect: boolean;
  score: number;
  correctAnswer: string;
  lyric: RoomLyricView;
}

@Injectable()
export class RoomsService {
  private readonly logger = new Logger(RoomsService.name);

  constructor(
    @InjectRepository(Room)
    private roomRepository: Repository<Room>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
    @InjectRepository(Lyrics)
    private lyricsRepository: Repository<Lyrics>,
    private readonly jobLock: JobLockService,
  ) {}

  async create(createRoomDto: CreateRoomDto) {
    let lyric: Lyrics;

    if (createRoomDto.lyricId) {
      const foundLyric = await this.lyricsRepository.findOne({
        where: { id: createRoomDto.lyricId, isActive: true },
      });
      if (!foundLyric) {
        throw new NotFoundException('Lyric not found');
      }
      lyric = foundLyric;
    } else {
      // Get a random lyric
      const foundLyric = await this.lyricsRepository
        .createQueryBuilder('lyrics')
        .where('lyrics.isActive = :isActive', { isActive: true })
        .orderBy('RANDOM()')
        .getOne();
      if (!foundLyric) {
        throw new NotFoundException('No lyrics available');
      }
      lyric = foundLyric;
    }

    // Generate a unique 6-character code
    const code = this.generateRoomCode();

    const room = this.roomRepository.create({
      name: createRoomDto.name,
      code,
      lyric,
      lyricId: lyric.id,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
    } as Room);

    return this.roomRepository.save(room);
  }

  /**
   * Generates a unique 6-character alphanumeric code.
   * Uses base36 encoding of random bytes for a short, URL-friendly code.
   */
  private generateRoomCode(): string {
    // 3 bytes = 24 bits = up to ~16M combinations, encoded in base36 gives ~5 chars
    // We'll use 4 bytes and take first 6 chars to be safe
    const bytes = crypto.randomBytes(4);
    // Convert to base36 (0-9, a-z) and ensure 6 characters
    let code = bytes.toString('base64')
      .replace(/[+/=]/g, '') // Remove base64 special chars
      .toLowerCase()
      .substring(0, 6);
    
    // If somehow shorter, pad with random chars
    while (code.length < 6) {
      code += Math.floor(Math.random() * 36).toString(36);
    }
    return code.substring(0, 6);
  }

  async join(roomId: string, userId: string) {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['roomUsers', 'lyric'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    this.assertPlayable(room);

    // Check if user already joined
    const existingRoomUser = await this.roomUserRepository.findOne({
      where: { roomId, userId },
    });

    if (existingRoomUser) {
      throw new ConflictException('User already joined this room');
    }

    const roomUser = this.roomUserRepository.create({
      roomId,
      userId,
    });

    return this.roomUserRepository.save(roomUser);
  }

  /**
   * Join a room using its short 6-character code instead of UUID.
   */
  async joinByCode(code: string, userId: string) {
    const room = await this.roomRepository.findOne({
      where: { code: code.toUpperCase() },
      relations: ['roomUsers', 'lyric'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    this.assertPlayable(room);

    // Check if user already joined
    const existingRoomUser = await this.roomUserRepository.findOne({
      where: { roomId: room.id, userId },
    });

    if (existingRoomUser) {
      throw new ConflictException('User already joined this room');
    }

    const roomUser = this.roomUserRepository.create({
      roomId: room.id,
      userId,
    });

    return this.roomUserRepository.save(roomUser);
  }

  /**
   * Get a paginated list of open (lobby) rooms.
   * Only returns rooms that are not closed and not expired.
   */
  async findOpenRooms(
    limit: number = 20,
    offset: number = 0,
  ): Promise<{ items: Room[]; total: number }> {
    const now = new Date();
    const qb = this.roomRepository
      .createQueryBuilder('room')
      .leftJoinAndSelect('room.lyric', 'lyric')
      .where('room.isClosed = :isClosed', { isClosed: false })
      .andWhere('(room.expiresAt IS NULL OR room.expiresAt > :now)', { now })
      .orderBy('room.createdAt', 'DESC')
      .take(limit)
      .skip(offset);

    const [items, total] = await qb.getManyAndCount();

    return { items, total };
  }

  async getRoomStatus(
    roomId: string,
    userId: string,
  ): Promise<RoomStatusView> {
    const room = await this.roomRepository.findOne({
      where: { id: roomId },
      relations: ['lyric', 'roomUsers', 'roomUsers.user'],
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    // Check if user has joined the room
    const roomUser = room.roomUsers.find((ru) => ru.userId === userId);
    if (!roomUser) {
      throw new NotFoundException('User has not joined this room');
    }

    return {
      id: room.id,
      name: room.name,
      createdAt: room.createdAt,
      expiresAt: room.expiresAt,
      isClosed: room.isClosed,
      // The answers stay hidden until this player has guessed.
      lyric: this.toLyricView(room.lyric, roomUser.hasGuessed),
      players: room.roomUsers.map((ru) => this.toPlayerView(ru)),
    };
  }

  async submitGuess(
    roomId: string,
    userId: string,
    guessDto: GuessLyricDto,
  ): Promise<RoomGuessResult> {
    const roomUser = await this.roomUserRepository.findOne({
      where: { roomId, userId },
      relations: ['room', 'room.lyric'],
    });

    if (!roomUser) {
      throw new NotFoundException('User has not joined this room');
    }

    if (roomUser.hasGuessed) {
      throw new ConflictException('User

/* … truncated 2450 chars — edit only what you need near the top … */

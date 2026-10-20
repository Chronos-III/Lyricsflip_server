import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Guard that attempts to authenticate a request using the `jwt` strategy but
 * never rejects it. When a valid bearer token is present, `req.user` is
 * populated with the authenticated user; otherwise the request proceeds
 * unauthenticated (`req.user` is left undefined).
 *
 * Used by endpoints that behave differently for authenticated users but are
 * still accessible anonymously (e.g. `GET /users/leaderboard` to compute
 * `myRank`).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(err: any, user: any): TUser {
    // Never throw: swallow authentication errors and return the user (if any).
    return (user ?? undefined) as TUser;
  }
}
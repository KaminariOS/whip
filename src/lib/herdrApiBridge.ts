import type { Request, ResponseResult, SessionSnapshot } from '../generated/herdrApi';
import type { HerdrEvent } from './herdrEvents';

type WithoutRequestId<T> = T extends { id: string } ? Omit<T, 'id'> : T;

/** UI-facing type for semantic requests; Rust assigns request IDs and owns the wire format. */
export type HerdrApiRequest = WithoutRequestId<Request>;
export type HerdrApiEvent = HerdrEvent;
export type SessionSnapshotResult = Extract<ResponseResult, { type: 'session_snapshot' }>;
export type { SessionSnapshot };

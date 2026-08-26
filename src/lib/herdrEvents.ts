import type { EventData } from '../generated/herdrApi';

type DotEventName<Name extends string> =
  Name extends `${infer Scope}_${infer EventName}` ? `${Scope}.${EventName}` : Name;

type DecodedEventData<Data extends { type: string }> = {
  [Key in keyof Omit<Data, 'type'>]: Exclude<Omit<Data, 'type'>[Key], null>;
};

type OfficialHerdrEvent<Data extends { type: string } = EventData> =
  Data extends EventData
    ? { event: DotEventName<Data['type']>; data: DecodedEventData<Data> }
    : never;

export type PaneAgentStatusChangedData = Extract<
  OfficialHerdrEvent,
  { event: 'pane.agent_status_changed' }
>['data'];

/** Trusted domain events delivered after native framing, normalization, and validation. */
export type HerdrEvent =
  | OfficialHerdrEvent
  | { event: 'protocol.unknown'; data: { raw_event: string } }
  | { event: 'protocol.invalid'; data: { raw_event: string; reason: string } };

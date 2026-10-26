// Every message that crosses a boundary between cloud, phone, gateway and barrier.
// All carry a version number. Times are whole seconds since 1970 (UTC).

import type { Signed } from './crypto.js';

export const PROTOCOL_VERSION = 1;

export type Role = 'driver' | 'admin' | 'temp_admin' | 'guest';
export type Action = 'lower' | 'raise' | 'maint_on' | 'maint_off' | 'clear_fault';

/** Signed by the organisation key. The phone carries it to the barrier. */
export interface DeviceCredential {
  v: 1;
  type: 'device_credential';
  deviceId: string;
  devicePub: string;
  personId: string;
  role: Role;
  accessPoints: string[];
  notBefore: number;
  notAfter: number;
  /** Revocation epoch at issue time. A barrier holding a newer list checks this device against it. */
  epoch: number;
}

/** Sent by the barrier over Bluetooth when a phone connects. Single use. */
export interface Challenge {
  v: 1;
  type: 'challenge';
  barrierId: string;
  nonce: string;
}

/** Built and signed by the phone's own key, answering one challenge. */
export interface PhoneCommand {
  v: 1;
  type: 'phone_command';
  barrierId: string;
  action: Action;
  nonce: string;
  deviceId: string;
}

export interface PhoneRequest {
  command: Signed<PhoneCommand>;
  credential: Signed<DeviceCredential>;
  /** Phones carry the newest revocation list they have, so barriers learn of revocations even offline. */
  revocation?: Signed<RevocationList>;
  /** Fresh signed time for this barrier's challenge, when the phone could reach the cloud. */
  time?: Signed<SignedTime>;
}

/** Signed by the cloud for a remote lower through the gateway. Never queued. */
export interface RemoteCommand {
  v: 1;
  type: 'remote_command';
  commandId: string;
  barrierId: string;
  action: 'lower' | 'raise';
  issuedAt: number;
  expiresAt: number;
  requestedBy: string;
}

/** Signed by the cloud. The barrier's clock only ever moves forward to these values. */
export interface SignedTime {
  v: 1;
  type: 'signed_time';
  t: number;
  /** Bound to one barrier and one of its challenge nonces, so an old time message can't be replayed. */
  barrierId: string;
  nonce: string;
}

/** Signed by the cloud. Carried by the gateway and by every phone that connects. */
export interface RevocationList {
  v: 1;
  type: 'revocation_list';
  epoch: number;
  issuedAt: number;
  revokedDeviceIds: string[];
}

/** Signed by the barrier's own key. Relayed by phones and the gateway; the cloud keeps one copy per seq. */
export interface BarrierEvent {
  v: 1;
  type: 'barrier_event';
  barrierId: string;
  seq: number;
  kind: string;
  detail: string;
  state: string;
  /** Barrier's trusted time, or null if its clock isn't trusted yet. */
  at: number | null;
}

export type DecisionCode =
  | 'ok'
  | 'bad_version'
  | 'bad_credential_signature'
  | 'credential_not_for_this_barrier'
  | 'credential_expired'
  | 'credential_not_yet_valid'
  | 'clock_untrusted'
  | 'device_revoked'
  | 'unknown_or_used_challenge'
  | 'bad_command_signature'
  | 'device_mismatch'
  | 'role_not_allowed'
  | 'bad_remote_signature'
  | 'remote_expired'
  | 'remote_replayed'
  | 'remote_raise_refused'
  | 'barrier_off'
  | 'state_refused';

export interface Decision {
  ok: boolean;
  code: DecisionCode;
  message: string;
  /** Set when the command was accepted by the protocol layer and passed to the state machine. */
  from?: string;
  to?: string;
}

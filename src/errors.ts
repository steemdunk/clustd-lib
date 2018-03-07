export class DisconnectedError extends Error {
  constructor(msg?: string) {
    super(msg);
  }
}

export enum HsRejectStatus {
  GENERIC_FAILURE,
  REJECTED
}

export class HandshakeRejected extends Error {

  readonly type: HsRejectStatus;

  constructor(type: HsRejectStatus, msg?: string) {
    super(msg ? msg : HsRejectStatus[type]);
    this.type = type;
  }
}

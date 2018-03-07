import { HandshakeRejected, HsRejectStatus } from './errors';
import { EventEmitter } from 'events';
import { Logger } from './logger';
import * as newDebug from 'debug';
import * as crypto from 'crypto';
import * as assert from 'assert';
import * as WebSocket from 'ws';

const debug = newDebug('clustd:client');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export interface CompleteLocalClient extends LocalClient {
  secretLen: number;
}

export interface LocalClient {
  secret: string;
  id: string;
  remoteAddress: string;
}

export class Client extends EventEmitter {

  private readonly logger = new Logger('client');

  readonly local: CompleteLocalClient;
  readonly serverSocket: boolean;
  private socket!: WebSocket;
  private ticket!: number;

  private incomingCtr: number = 0;
  private outgoingCtr: number = 0;
  private initialized = false;

  get open() { return this.socket.readyState === WebSocket.OPEN; }

  constructor(local: LocalClient, serverSocket: boolean, socket?: WebSocket) {
    super();
    local.secret = String(local.secret);
    this.local = {
      secret: local.secret,
      secretLen: Buffer.byteLength(local.secret, 'utf8'),
      remoteAddress: local.remoteAddress,
      id: local.id
    };
    this.serverSocket = serverSocket;
    this.socket = socket!;
  }

  async init(): Promise<void> {
    await this.listen();
    if (this.serverSocket) {
      this.ticket = crypto.randomBytes(4).readUInt32BE(0);
      await this.sendHello();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.initialized) {
          return reject(new HandshakeRejected(HsRejectStatus.GENERIC_FAILURE));
        }
        resolve();
      }, 5000);
      this.once('handshake_complete', success => {
        clearTimeout(timer);
        if (!success) {
          return reject(new HandshakeRejected(HsRejectStatus.REJECTED));
        }
        resolve();
      });
    });
  }

  close(): void {
    if (this.open) {
      this.socket.close();
    }
  }

  ping(): void {
    if (this.open) {
      this.socket.ping();
    }
  }

  setSocket(ws: WebSocket): void {
    assert(!this.socket, 'socket must be initially undefined');
    this.socket = ws;
  }

  private async listen(): Promise<void> {
    this.socket.on('message', async encryptedData => {
      try {
        const data = this.decryptMsg(encryptedData as Buffer);
        debug('Received data: %o', data);
        if (data.hello_world) {
          if (this.initialized) {
            this.close();
            this.logger.error('Socket handshake already initialized');
            return;
          }
          this.ticket = data.hello_world;
          if (!this.serverSocket) await this.sendHello();
          this.once('handshake_complete', success => {
            if (success) {
              this.initialized = true;
              debug('Handshake completed');
            } else {
              debug('Handshake rejected');
            }
          });
          this.emit('handshake_verify', data);
        } else if (!data.hello_world) {
          if (!this.initialized) {
            this.close();
            this.logger.error('Receiving a message before handshake is complete');
          }
          this.emit('message', data);
        }
      } catch (e) {
        this.logger.error('Failed to process message', e);
      }
    });

    this.socket.on('ping', data => {
      this.emit('ping', data);
    });

    this.socket.on('pong', data => {
      this.emit('pong', data);
    });

    this.socket.on('close', () => {
      this.emit('close');
      this.removeAllListeners();
      this.socket.removeAllListeners();
    });

    this.socket.on('error', (err: any) => {
      if (!(err.code === 'ECONNREFUSED'
            || err.code === 'EHOSTDOWN'
            || err.code === 'ETIMEDOUT'
            || err.message === 'WebSocket was closed before the connection was established')) {
        this.logger.error('Unknown client socket error', err);
      }
    });

    if (!this.serverSocket) {
      return new Promise<void>((resolve, reject) => {
        const hook = () => {
          this.socket.removeListener('open', res);
          this.socket.removeListener('error', rej);
          this.socket.removeListener('close', rej);
          clearTimeout(timer);
        }

        const res = () => {
          hook();
          resolve();
        }

        const rej = (err?: any) => {
          hook();
          this.socket.close();
          reject(err);
        }

        const timer = setTimeout(() => {
          rej(new Error('ETIMEDOUT'));
        }, 3000);

        this.socket.once('open', res);
        this.socket.once('error', rej);
        this.socket.once('close', rej);
      });
    }
  }

  async sendMessage(data: any, force?: boolean) {
    return new Promise((resolve, reject) => {
      if (!(this.initialized || force)) {
        return reject(new Error('connection not initialized'));
      } else if (!this.open) {
        return reject(new Error('connection closed'));
      }

      try {
        const enc = this.encryptMsg(data);
        this.socket.send(enc, err => {
          debug('Sent message: %o', data);
          !err ? resolve() : reject(err);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  private async sendHello() {
    await this.sendMessage({
      hello_world: this.ticket,
      id: this.local.id,
      remote_address: this.local.remoteAddress
    }, true);
  }

  encryptMsg(data: any): Uint8Array {
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.getKey(++this.outgoingCtr);
    const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
    const enc = Buffer.concat([
      cipher.update(JSON.stringify(data), 'utf8'),
      cipher.final()
    ]);
    const tag = cipher.getAuthTag();
    const length = IV_LENGTH + TAG_LENGTH + enc.length;
    return new Uint8Array(Buffer.concat([iv, tag, enc], length));
  }

  decryptMsg(buf: Buffer): any {
    let final!: Buffer;
    try {
      const iv = Buffer.from(buf).slice(0, IV_LENGTH);
      const tag = buf.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
      const rawData = buf.slice(IV_LENGTH + TAG_LENGTH);
      const key = this.getKey(++this.incomingCtr);

      const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
      decipher.setAuthTag(tag);
      final = Buffer.concat([
        decipher.update(rawData),
        decipher.final()
      ]);
    } catch (e) {
      this.close();
      debug('Failed to decrypt message %o', e);
      assert(false, 'message decryption failure, verify the cluster secret');
    }
    return JSON.parse(final.toString('utf8'));
  }

  private getKey(nonce: number): Buffer {
    const secret = Buffer.allocUnsafe(this.local.secretLen
                                        + (this.initialized ? 8 : 4));
    secret.write(this.local.secret, 0, this.local.secretLen, 'utf8');
    secret.writeUInt32BE(nonce, this.local.secretLen);
    if (this.initialized) {
      secret.writeUInt32BE(this.ticket, this.local.secretLen + 4);
    }

    const hasher = crypto.createHash('sha256');
    return hasher.update(secret).digest().slice(0, 16);
  }

}

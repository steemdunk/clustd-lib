import {
  DisconnectedError,
  HandshakeRejected,
  HsRejectStatus
} from '../errors';
import { Client, LocalClient } from '../client';
import { EventEmitter } from 'events';
import { Logger } from '../logger';
import * as newDebug from 'debug';
import * as assert from 'assert';
import * as WebSocket from 'ws';

const debug = newDebug('clustd:machine');
let globalId = 0;

interface Request {
  resolve: (data) => void;
  reject: (err) => void;
}

export abstract class GenericMachine extends EventEmitter {

  abstract type: string;
  host: string;

  protected readonly logger = new Logger('machine', (msg) => {
    return `[${this.id ? this.id : this.host} (${this.globalId})] ${msg}`;
  });

  protected client?: Client;
  private globalId: number = globalId++;
  private _id?: string;
  private _active: boolean;
  private reqId: number = 0;
  private reqs: { [id: string]: Request } = {};

  private connectionTimer!: NodeJS.Timer;
  private pingTimer!: NodeJS.Timer;
  private lastPong: number = 0;

  readonly localClient: LocalClient;
  readonly local: boolean;

  get active() { return this._active; }
  get open() {
    return this.local || (this.active && this.client && this.client.open);
  }

  get id() { return this._id; }

  constructor(clientOpts: LocalClient, host?: string) {
    super();
    this.localClient = clientOpts;
    this.host = host!;
    this.local = clientOpts.remoteAddress === host;
    this._active = this.local;
    if (this.local) {
      this._id = clientOpts.id;
      this.logger.info('Initialized local machine');
    }
  }

  abstract onRequest(method: string, params?: any): Promise<any>;

  start(): void {
    if (this.active || this.local) return;
    this._active = true;
    this.schedulePing();
  }

  stop() {
    if (this.local) return;
    this._active = false;
    if (this.client) {
      this.client.removeAllListeners();
      this.client.close();
      this.client = undefined;
    }
    this.removeAllListeners();
    clearTimeout(this.connectionTimer);
    clearTimeout(this.pingTimer);
    this.lastPong = 0;
    for (const key of Object.keys(this.reqs)) {
      const req = this.reqs[key];
      delete this.reqs[key];
      req.reject(new Error('stopped'));
    }
  }

  setClient(client: Client): boolean {
    assert(!this.local, 'cannot set client on a local machine');
    assert(this.active, 'machine must be considered active');
    assert(this.id, 'machine missing id');
    assert(this.host, 'machine missing host');
    if (this.client && this.client.open) return false;
    this.client = client;

    this.client.on('ping', () => {
      this.lastPong = Date.now();
      debug('[%s] Received ping request', this.id);
    });

    this.client.on('pong', () => {
      this.lastPong = Date.now();
      debug('[%s] Received pong response', this.id);
    });

    return true;
  }

  async send(method: string, params?: any) {
    if (!this.open) {
      throw new DisconnectedError();
    }
    const id = this.reqId++;
    return new Promise<any>(async (resolve, reject) => {
      const timer = setTimeout(() => {
        request.reject(new Error('timed out'));
      }, 3000);

      const request: Request = {
        resolve: data => {
          delete this.reqs[id];
          clearTimeout(timer);
          resolve(data);
        },
        reject: error => {
          delete this.reqs[id];
          clearTimeout(timer);
          reject(error);
        }
      };

      try {
        this.reqs[id] = request;
        await this.client!.sendMessage({
          req_id: id,
          method,
          params
        });
      } catch (e) {
        request.reject(e);
      }
    });
  }

  async initClient(client: Client, clientOnlyConnect = false): Promise<void> {
    client.on('handshake_verify', async data => {
      try {
        if (this._id) {
          // TODO allow ID renaming
          assert(data.id === this._id, `id mismatch: ${this._id} -> ${data.id}`);
        }
        {
          this._id = data.id;
          assert(this._id, 'handshake missing id');
        }

        if (!clientOnlyConnect) {
          this.host = data.remote_address;
          assert(this.host, 'handshake missing remote address');
        }

        const shouldAccept = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('unable to determine handshake acceptance'));
          }, 3000);
          this.once('handshake_accept', success => {
            clearTimeout(timer);
            resolve(success);
          });
          this.emit('should_accept_handshake');
        });

        if (!shouldAccept) {
          return client.emit('handshake_complete', false);
        }

        this.lastPong = Date.now();
        if (this.setClient(client)) {
          this.logger.info('Successfully connected');
          client.emit('handshake_complete', true);
        } else {
          throw new Error('failed to set client');
        }
      } catch (e) {
        this.logger.error('Handshake failed:', e.message);
        client.emit('handshake_complete', false);
      }
    });

    client.on('message', async msg => {
      if (msg.req_id !== undefined) {
        const id = msg.req_id;
        const method = msg.method;
        const params = msg.params;
        try {
          const rawRes: any = {
            res_id: id
          };
          const resp = await this.onRequest(method, params);
          if (resp) rawRes.data = resp;
          else rawRes.error = 'unrecognized method for this machine';
          await this.client!.sendMessage(rawRes);
        } catch (e) {
          this.logger.error('Failed to process message', e);
          this.client!.sendMessage({
            res_id: id,
            error: 'failed to process message'
          }).catch(e => {
            this.logger.error('Failed to send response:', e);
          });
        }
      } else if (msg.res_id !== undefined) {
        const req = this.reqs[msg.res_id];
        if (req) {
          delete this.reqs[msg.res_id];
          req.resolve(msg.data);
        }
      } else {
        this.logger.warn('Message dropped: ', msg);
      }
    });

    client.on('close', () => {
      if (this.client) {
        this.logger.warn('Connection lost');
        const serverSocket = this.client.serverSocket;
        this.client = undefined;
        this.emit('close');
        if (!clientOnlyConnect
            || (clientOnlyConnect && !serverSocket)) {
          this.scheduleConnection();
        }
      }
    });

    await client.init();
  }

  scheduleConnection(time = 5000, rejectOnFail = false): Promise<any> {
    assert(!this.local, 'only remote machines can schedule connections');
    let resolve: () => void;
    let reject: (err) => void;
    const prom: Promise<any> = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.connectionTimer = setTimeout(async () => {
      try {
        if (!this.active || this.open) {
          return;
        }
        const client = new Client(this.localClient, false);
        const meta = Buffer.from(client.encryptMsg({
          type: this.type
        }).buffer as ArrayBuffer);
        client.setSocket(new WebSocket(this.host, {
          headers: {
            'metadata': meta.toString('base64')
          }
        }));
        try {
          await this.initClient(client);
        } catch (e) {
          if (!(e instanceof HandshakeRejected
                && e.type === HsRejectStatus.REJECTED)) {
            throw e;
          }
          return resolve();
        }
        resolve();
        this.emit('open');
      } catch (e) {
        const err = 'Failed to connect to host: ' + e.message;
        this.logger.error(err);
        this.scheduleConnection();
        if (rejectOnFail) reject(new Error(err));
        else resolve();
      }
    }, time);
    return prom;
  }

  private schedulePing(time = 1500) {
    assert(!this.local, 'only remote machines can schedule connections');
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.active) {
        clearInterval(this.pingTimer);
        return;
      } else if (!this.client) {
        return;
      } else if (!this.client.open) {
        return this.logger.warn('Attempting to ping a closed machine');
      }

      debug('[%s] Sent ping request', this.id);
      const delta = Date.now() - this.lastPong;
      if (this.lastPong !== 0 && delta > (time * 2)) {
        debug('[%s] Pong delta is too great, closing connection', this.id);
        this.client.close();
        this.client.emit('close');
        return;
      }
      this.client.ping();
    }, time);
  }
}

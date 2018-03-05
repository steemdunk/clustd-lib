import { GenericMachine } from './generic_machine';
import { LocalClient } from '../client';
import * as crypto from 'crypto';
import * as assert from 'assert';

export interface DriverClient {
  secret: string;
  id: string;
}

export abstract class DriverMachine extends GenericMachine {

  readonly type = 'driver';

  constructor(dc: DriverClient, host: string, autoGenId = true) {
    super(dc as LocalClient, host);
    if (autoGenId) {
      dc.id += '-' + crypto.randomBytes(4).readUInt32BE(0).toString()
    }
    assert(host, 'host must be provided in a driver');
  }

  /**
   *
   * @param master Whether the cluster machine the driver is connected to became
   * the master.
   *
   * Returns whether the trigger was successful.
   */
  abstract trigger(master: boolean): void;

  async onRequest(method: string, params?: any): Promise<any> {
    switch (method) {
      case 'trigger':
        assert(!this.client!.serverSocket, 'client only method');
        assert(params, 'params must be supplied');

        const isMaster: boolean = params!.isMaster;
        assert(typeof(isMaster) === 'boolean', 'param isMaster not a boolean');
        try {
          this.trigger(isMaster);
        } catch (e) {
          this.logger.error('Failed to execute trigger on driver', e);
        }
        return {};
    }
  }

  async connect() {
    this.start();
    await this.scheduleConnection(0, false);
  }
}

import { GenericMachine } from './generic_machine';
import { LocalClient } from '../client';

export abstract class DriverMachine extends GenericMachine {

  readonly type = 'driver';

  constructor(localClient: LocalClient, host?: string) {
    super(localClient, host);
  }

  abstract start(): Promise<boolean>;
  abstract stop(): Promise<boolean>;

  async onRequest(method: string, params?: any[]): Promise<any> {
    let success = false;
    switch (method) {
      case 'start':
        success = await this.start();
        break;
      case 'stop':
        success = await this.stop();
        break;
    }
    return {
      success
    };
  }
}

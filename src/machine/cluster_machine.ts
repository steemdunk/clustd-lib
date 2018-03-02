import { GenericMachine } from './generic_machine';
import * as assert from 'assert';
import { LocalClient } from '..';

export class ClusterMachine extends GenericMachine {

  readonly type = 'cluster';
  master: boolean = false;

  constructor(localClient: LocalClient, host?: string) {
    super(localClient, host);
  }

  async onRequest(method: string, params?: any): Promise<any> {
    switch (method) {
      case 'get_master':
        let masterId: string|undefined;
        this.once('cluster_master_current', id => {
          masterId = id;
        });
        this.emit('cluster_master_get');
        assert(masterId, 'master ID must be present');
        return {
          master: masterId
        };
    }
    return undefined;
  }
}

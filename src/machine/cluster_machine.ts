import { GenericMachine } from './generic_machine';
import { LocalClient } from '../client';

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
        return {
          master: masterId
        };
    }
    return undefined;
  }
}

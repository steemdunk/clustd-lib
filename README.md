# Clustd Library

This is the library for writing drivers for clustd. Drivers are intended to run on the same machine as a clustd instance and connect to that local daemon. Drivers are simple to implement and designed to be a plug & play system to control the system when a master machine goes down.

## Setting up a cluster

The clustd project is what actually provides the cluster implementation. The daemon runs in the background and will execute driver triggers when a machine becomes a master.

See more details: https://github.com/steemdunk/clustd

## Creating a driver

```ts
class MyDriver extends DriverMachine {

  constructor() {
    super({
      id: 'driver-mydriver',
      secret: Config.secret
    }, Config.host);
  }

  async trigger(isMaster: boolean): Promise<void> {
    if (isMaster) {
      this.logger.info('Starting service...');
      // Do things...
    } else {
      this.logger.info('Stopping service...');
      // Do things...
    }
  }
}

const d = new MyDriver();
d.connect();
```

That's all there is to it! `trigger` is automatically invoked when the clustd instance becomes a master or is no longer master. That simple action can then invoke actions on the system.

## Available drivers

- [Execute shell commands](https://github.com/steemdunk/clustd-driver-shell)
- [Automatic DNS updating](https://github.com/steemdunk/clustd-driver-cloudflare)

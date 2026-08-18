declare module "homey" {
  namespace Homey {
    type LogFn = (...args: unknown[]) => void;

    type FlowRunListener = (args: Record<string, unknown>, state?: Record<string, unknown>) => unknown;
    type FlowArgumentAutocompleteListener = (
      query: string,
      args: Record<string, unknown>,
    ) => unknown;

    type FlowCard = {
      registerArgumentAutocompleteListener(name: string, listener: FlowArgumentAutocompleteListener): FlowCard;
      registerRunListener(listener: FlowRunListener): FlowCard;
    };

    type DeviceTriggerCard = FlowCard & {
      trigger(
        device: Device,
        tokens?: Record<string, unknown>,
        state?: Record<string, unknown>,
      ): Promise<unknown>;
    };

    type FlowManager = {
      getActionCard(id: string): FlowCard;
      getDeviceTriggerCard(id: string): DeviceTriggerCard;
    };

    class App {
      homey: {
        flow: FlowManager;
        manifest: {
          version: string;
        };
        settings: {
          get(key: string): unknown;
          set(key: string, value: unknown): void;
        };
      };

      error: LogFn;
      log: LogFn;
    }

    class Driver {
      homey: App["homey"];

      error: LogFn;
      log: LogFn;
    }

    namespace Driver {
      type PairDevice = {
        name: string;
        data: Record<string, string | number | boolean | object>;
        icon?: string;
        settings?: Record<string, unknown>;
        store?: Record<string, unknown>;
      };

      type PairSession = {
        emit(event: string, data?: unknown): Promise<void>;
        nextView(): Promise<void>;
        setHandler(event: string, handler: (...args: any[]) => unknown): PairSession;
      };
    }

    class Device {
      homey: App["homey"];

      error: LogFn;
      log: LogFn;

      addCapability(capabilityId: string): Promise<void>;
      getCapabilityValue(capabilityId: string): unknown;
      getData(): Record<string, unknown>;
      getSetting(key: string): unknown;
      getStore(): Record<string, unknown>;
      hasCapability(capabilityId: string): boolean;
      registerCapabilityListener(
        capabilityId: string,
        listener: (value: unknown, options?: Record<string, unknown>) => unknown,
      ): void;
      removeCapability(capabilityId: string): Promise<void>;
      setAvailable(): Promise<void>;
      setStoreValue(key: string, value: unknown): Promise<void>;
      setCapabilityValue(capabilityId: string, value: boolean | number | string): Promise<void>;
      setUnavailable(message?: string): Promise<void>;
    }

    const env: Record<string, string | undefined>;
    const manifest: {
      drivers: Array<{ id: string }>;
      version: string;
    };
  }

  export = Homey;
}

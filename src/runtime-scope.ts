import { AsyncLocalStorage } from 'node:async_hooks';

type RuntimeValueMap = Record<string, unknown>;
type RuntimeHandler = (...args: any[]) => unknown;

interface RuntimeScopeStore {
  configOverlay: Readonly<RuntimeValueMap>;
  handlers: Readonly<Record<string, RuntimeHandler>>;
  metadata: Readonly<Record<string, string>>;
}

const runtimeScope = new AsyncLocalStorage<RuntimeScopeStore>();
const installedConfigObjects = new WeakMap<object, Map<string, unknown>>();

function frozenCopy<T extends Record<string, unknown>>(value: T): Readonly<T> {
  return Object.freeze({ ...value });
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasRuntimeScope(): boolean {
  return Boolean(runtimeScope.getStore());
}

export function runWithRuntimeScope<T>(
  fn: () => T,
  metadata: Record<string, string> = {}
): T {
  const store: RuntimeScopeStore = {
    configOverlay: frozenCopy({}),
    handlers: Object.freeze({}),
    metadata: frozenCopy(metadata),
  };
  return runtimeScope.run(store, fn);
}

export function getScopedConfigValue(key: string): { found: boolean; value?: unknown } {
  const store = runtimeScope.getStore();
  if (!store || !hasOwn(store.configOverlay, key)) {
    return { found: false };
  }
  return { found: true, value: store.configOverlay[key] };
}

export function setScopedConfigValue(key: string, value: unknown): boolean {
  const store = runtimeScope.getStore();
  if (!store) return false;
  store.configOverlay = frozenCopy({
    ...store.configOverlay,
    [key]: value,
  });
  return true;
}

export function getScopedHandler<T extends RuntimeHandler>(key: string): T | undefined {
  const store = runtimeScope.getStore();
  return store?.handlers[key] as T | undefined;
}

export function setScopedHandler<T extends RuntimeHandler>(
  key: string,
  handler: T
): (() => void) | undefined {
  const store = runtimeScope.getStore();
  if (!store) return undefined;

  const hadPrevious = hasOwn(store.handlers, key);
  const previous = store.handlers[key];
  store.handlers = Object.freeze({
    ...store.handlers,
    [key]: handler,
  });

  return () => {
    const next = { ...store.handlers } as Record<string, RuntimeHandler>;
    if (hadPrevious && previous) next[key] = previous;
    else delete next[key];
    store.handlers = Object.freeze(next);
  };
}

export function installScopedConfig<T extends object>(config: T): T {
  if (installedConfigObjects.has(config)) return config;

  const baseValues = new Map<string, unknown>();
  installedConfigObjects.set(config, baseValues);

  for (const key of Object.keys(config)) {
    baseValues.set(key, (config as Record<string, unknown>)[key]);
    Object.defineProperty(config, key, {
      configurable: true,
      enumerable: true,
      get() {
        const scoped = getScopedConfigValue(key);
        return scoped.found ? scoped.value : baseValues.get(key);
      },
      set(value: unknown) {
        if (!setScopedConfigValue(key, value)) {
          baseValues.set(key, value);
        }
      },
    });
  }

  return config;
}

export function runtimeScopeMetadata(): Readonly<Record<string, string>> | null {
  return runtimeScope.getStore()?.metadata || null;
}

export const __test__ = {
  getScopedConfigValue,
  getScopedHandler,
  hasRuntimeScope,
};

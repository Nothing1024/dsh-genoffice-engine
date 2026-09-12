const memory = new Map<string, string>()
const storage: Storage = {
  get length() {
    return memory.size
  },
  clear() {
    memory.clear()
  },
  getItem(key: string) {
    return memory.has(key) ? memory.get(key)! : null
  },
  key(index: number) {
    return Array.from(memory.keys())[index] ?? null
  },
  removeItem(key: string) {
    memory.delete(key)
  },
  setItem(key: string, value: string) {
    memory.set(String(key), String(value))
  },
}

function install(target: object): void {
  const desc = Object.getOwnPropertyDescriptor(target, 'localStorage')
  if (desc && desc.value && typeof (desc.value as Storage).getItem === 'function') return
  try {
    Object.defineProperty(target, 'localStorage', {
      configurable: true,
      enumerable: true,
      writable: true,
      value: storage,
    })
  } catch {
    /* jsdom may already expose a broken accessor */
    try {
      (target as { localStorage: Storage }).localStorage = storage
    } catch {
      /* ignore */
    }
  }
}

install(globalThis)
const win = (globalThis as { window?: object }).window
if (win) install(win)

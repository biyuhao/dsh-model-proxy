declare module '@deepseek-ai/cordis' {
  export type Context = any
  export const Service: any
}
declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(s: string): any
  export function installSettingsSection(...args: any[]): void
}
declare module '@deepseek-ai/dsh-llm' {
  export type GenerateOptions = { provider: string; model: string; [k: string]: any }
}
declare module '@deepseek-ai/dsh-invariants' {
  export type InvariantInstaller = () => void
}
declare module '@deepseek-ai/schemastery' {
  const z: {
    object: (o: any) => any
    string: () => any
    boolean: () => any
    array: (t: any) => any
  }
  export default z
}
declare module 'undici' {
  export class ProxyAgent {
    constructor(url: string | { uri: string; keepAliveTimeout?: number; connections?: number | null })
  }
}
declare module '@deepseek-ai/dsh-client-runtime/client' {
  export type SettingsScope<T> = {
    getSnapshot(): any
    subscribe(cb: () => void): () => void
    set(field: string, value: any): Promise<void>
  }
}
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}

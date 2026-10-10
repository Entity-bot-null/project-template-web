// import-in-the-middle ships register-hooks.d.ts next to register-hooks.mjs, a
// pair TypeScript does not match (an .mjs file looks for .d.mts). These are the
// package's own declarations for the one entry point telemetry-sdk.ts uses.
declare module 'import-in-the-middle/register-hooks.mjs' {
  export interface RegisterHooksOptions {
    include?: (string | RegExp)[];
    exclude?: (string | RegExp)[];
    disableCjsSourceStripping?: boolean;
  }

  /** Registers the loader in-thread (module.registerHooks). */
  export function register(options?: RegisterHooksOptions): void;

  export function supportsSyncHooks(): boolean;
}

// What an .astro import is for tools that read TypeScript without Astro's
// language service, such as ESLint's type-aware rules on a spec that renders
// a component: a component the container API can render. `astro check`
// (pnpm typecheck) resolves the real file and checks each component's props.
declare module '*.astro' {
  import type { experimental_AstroContainer } from 'astro/container';

  const Component: Parameters<experimental_AstroContainer['renderToString']>[0];
  export default Component;
}

// Where the web app (apps/web) lives on this origin: the base it is built
// with and its router's basename. The landing links to it, never to a
// separate domain, so a visitor stays on one origin from the first page.
export const APP_PATH = '/app/';

/** The address of a screen of the web app: appPath('sign-in') is /app/sign-in. */
export function appPath(screen = ''): string {
  if (screen.startsWith('/')) {
    throw new Error(`A screen is relative to the app, without a leading slash: "${screen}"`);
  }
  return `${APP_PATH}${screen}`;
}

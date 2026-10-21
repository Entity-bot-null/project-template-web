import { describe, expect, it } from 'vitest';
import { APP_PATH, appPath } from './links';

describe('appPath', () => {
  it('points at the web app on this origin, under its base path', () => {
    expect(APP_PATH).toBe('/app/');
    expect(appPath()).toBe('/app/');
    expect(appPath('sign-in')).toBe('/app/sign-in');
  });

  it('refuses a screen with a leading slash, which would leave the app', () => {
    expect(() => appPath('/sign-in')).toThrow(/without a leading slash/);
  });
});

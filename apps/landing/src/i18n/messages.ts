// The shape of every dictionary: a text added here must be written in each
// language (en.ts, es.ts) before the site compiles.

/** A headline as it is set: two lines, broken where the words read best. */
export type TwoLines = readonly [string, string];

export interface Capability {
  readonly name: string;
  readonly description: string;
}

export interface Messages {
  /** The language's own name, as the language links show it. */
  readonly languageName: string;
  readonly skipToContent: string;
  /** What the shared picture shows (public/og.png), for those who cannot see it. */
  readonly shareImageAlt: string;
  readonly header: {
    /** Accessible name of the navigation landmark. */
    readonly navigation: string;
    readonly signIn: string;
  };
  readonly home: {
    /** The page title (browser tab, search results), after the site's name. */
    readonly title: string;
    readonly description: string;
    readonly heading: TwoLines;
    readonly lead: string;
    readonly action: string;
  };
  readonly capabilities: {
    readonly heading: string;
    readonly items: readonly [
      Capability,
      Capability,
      Capability,
      Capability,
      Capability,
      Capability,
    ];
  };
  readonly gettingIn: {
    readonly heading: string;
    readonly invited: string;
    readonly accepted: string;
    readonly signedIn: string;
    /** What each picture of the app shows, for screen readers. */
    readonly pictures: {
      readonly inviteForm: string;
      readonly invitationEmail: string;
      readonly acceptForm: string;
      readonly home: string;
    };
  };
  readonly callToAction: {
    readonly heading: TwoLines;
    readonly body: string;
    readonly action: string;
  };
  readonly footer: {
    readonly openApp: string;
    readonly languages: string;
    readonly rights: string;
    readonly backToTop: string;
  };
  readonly notFound: {
    readonly title: string;
    readonly heading: TwoLines;
    readonly body: string;
    readonly action: string;
  };
}
